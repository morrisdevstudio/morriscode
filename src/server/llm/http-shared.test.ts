import { describe, expect, it } from 'vitest'
import { readResponseLines } from './http-shared.js'

function responseFromChunks(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  )
}

describe('readResponseLines', () => {
  it('preserves split UTF-8 characters and lines, trims blanks, and drops the unfinished final line', async () => {
    const bytes = new TextEncoder().encode('  café \r\n\nnext\nunfinished')
    const response = responseFromChunks(bytes.slice(0, 6), bytes.slice(6, 10), bytes.slice(10))
    const lines: string[] = []
    for await (const line of readResponseLines(response)) lines.push(line)
    expect(lines).toEqual(['café', 'next'])
    expect(response.body?.locked).toBe(false)
  })

  it('releases the reader when the consumer stops early', async () => {
    const response = responseFromChunks(new TextEncoder().encode('first\nsecond\n'))
    for await (const line of readResponseLines(response)) {
      expect(line).toBe('first')
      break
    }
    expect(response.body?.locked).toBe(false)
  })

  it('propagates read errors and releases the reader', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('read failed'))
        },
      }),
    )
    await expect(readResponseLines(response).next()).rejects.toThrow('read failed')
    expect(response.body?.locked).toBe(false)
  })

  it('rejects responses without a streaming body', async () => {
    await expect(readResponseLines(new Response(null)).next()).rejects.toThrow('No response body for streaming')
  })
})
