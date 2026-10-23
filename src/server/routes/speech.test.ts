import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createSpeechRoutes } from './speech.js'
import type { SpeechEngine } from '../speech/service.js'
import type { SpeechStatus } from '../../shared/speech.js'
import { SpeechCanceledError } from '../speech/service.js'

const readyStatus: SpeechStatus = {
  state: 'ready',
  installed: true,
  stage: 'verifying',
  progress: 100,
  cpuOnly: true,
  voice: 'ff_siwis',
}

function fakeService(overrides: Partial<SpeechEngine> = {}): SpeechEngine {
  return {
    getStatus: () => readyStatus,
    install: () => ({ ...readyStatus, state: 'installing', installed: false, progress: 10 }),
    generate: vi.fn(async () => ({
      audio: Buffer.from('RIFF-test'),
      durationMs: 1200,
      generationMs: 300,
    })),
    cancel: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

async function startServer(service: SpeechEngine) {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/speech', createSpeechRoutes(service))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as { port: number }
  return { server, baseUrl: 'http://127.0.0.1:' + address.port }
}

describe('speech routes', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('prepares readable text without code or URLs', async () => {
    const { server, baseUrl } = await startServer(fakeService())
    servers.push(server)
    const response = await fetch(baseUrl + '/api/speech/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '## Explication\n\nCorrection prête. [Détails](https://example.com)\n\n```ts\nsecret()\n```',
        textSegments: [],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { chunks: string[] }
    expect(body.chunks.join(' ')).toContain('Explication')
    expect(body.chunks.join(' ')).toContain('Correction prête')
    expect(body.chunks.join(' ')).toContain('Détails')
    expect(body.chunks.join(' ')).not.toContain('secret')
    expect(body.chunks.join(' ')).not.toContain('example.com')
  })

  it('returns WAV audio and cancellation does not expose request text', async () => {
    const generate = vi.fn(async () => ({
      audio: Buffer.from('RIFF-test'),
      durationMs: 1200,
      generationMs: 300,
    }))
    const { server, baseUrl } = await startServer(fakeService({ generate }))
    servers.push(server)
    const response = await fetch(baseUrl + '/api/speech/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Bonjour.', language: 'fr', requestId: 'request-1' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('audio/wav')
    expect(response.headers.get('x-speech-duration-ms')).toBe('1200')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('RIFF-test')
    expect(generate).toHaveBeenCalledWith('Bonjour.', 'fr', 'request-1')
  })

  it('reports unavailable engines and rejects unreadable messages', async () => {
    const generate = vi.fn(async () => {
      throw new SpeechCanceledError()
    })
    const service = fakeService({ generate })
    const { server, baseUrl } = await startServer(service)
    servers.push(server)

    const empty = await fetch(baseUrl + '/api/speech/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '```sh\nnpm test\n```' }),
    })
    expect(empty.status).toBe(422)

    const canceled = await fetch(baseUrl + '/api/speech/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Bonjour.', language: 'fr', requestId: 'request-2' }),
    })
    expect(canceled.status).toBe(204)
  })
})
