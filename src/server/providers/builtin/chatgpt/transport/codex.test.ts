import { describe, expect, it, vi } from 'vitest'
import type { ProviderAuthAdapter } from '../../../../../provider/index.js'
import type { LLMCompletionRequest } from '../../../../llm/types.js'
import { CodexTransportAdapter, parseRateLimitEvent, parseRateLimitHeaders, parseWhamUsage } from './codex.js'

const whamPayload = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 42, reset_at: 1792158000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 18, reset_at: 1792676400, limit_window_seconds: 604_800 },
  },
  credits: { has_credits: true, unlimited: false, balance: '12.50' },
}

function authStub(): ProviderAuthAdapter {
  return {
    id: 'openai-account',
    beginLogin: vi.fn(),
    getStatus: vi.fn(),
    logout: vi.fn(),
    getAccessContext: vi.fn().mockResolvedValue({ accessToken: 'token', headers: { Authorization: 'Bearer token' } }),
  } as unknown as ProviderAuthAdapter
}

const completion: LLMCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] }

const sse = (...events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

const streamContext = { providerId: 'p1', credentialRef: 'cred-1' }
const partialTool = {
  type: 'response.output_item.added',
  output_index: 0,
  item: { type: 'function_call', call_id: 'call-1', name: 'write_file', arguments: '{"path":"a"}' },
}

describe('CodexTransportAdapter stream integrity', () => {
  it.each([
    { type: 'response.failed', response: { error: { message: 'Backend failed' } } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    { type: 'error', message: 'Stream rejected' },
    { type: 'error', error: { message: 'Nested stream error' } },
    { type: 'response.completed', response: { status: 'failed' } },
    { type: 'response.done' },
  ])('rejects unsuccessful terminal event $type without final tools', async (terminal) => {
    const transport = new CodexTransportAdapter(authStub(), {
      fetch: vi.fn().mockResolvedValue(new Response(sse(partialTool, terminal))),
    })
    const events = []
    for await (const event of transport.stream(completion, streamContext)) events.push(event)
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    const detail =
      'message' in terminal
        ? terminal.message
        : 'error' in terminal
          ? terminal.error.message
          : 'response' in terminal && terminal.response && 'error' in terminal.response
            ? terminal.response.error.message
            : 'response' in terminal && terminal.response && 'incomplete_details' in terminal.response
              ? terminal.response.incomplete_details.reason
              : undefined
    if (detail) expect(events.at(-1)).toMatchObject({ error: expect.stringContaining(detail) })
  })

  it.each(['', 'data: [DONE]\n\n', 'data: {"type":"response.completed"}'])(
    'rejects EOF without a complete confirmation frame (%j)',
    async (ending) => {
      const transport = new CodexTransportAdapter(authStub(), {
        fetch: vi.fn().mockResolvedValue(new Response(sse(partialTool) + ending)),
      })
      await expect(transport.complete(completion, streamContext)).rejects.toThrow(/complet/i)
    },
  )

  it('accepts CRLF frames split across chunks and preserves UTF-8 text and tools', async () => {
    const bytes = new TextEncoder().encode(
      sse({ type: 'response.output_text.delta', delta: 'été' }, partialTool, {
        type: 'response.completed',
        response: { id: 'r1', status: 'completed' },
      }).replaceAll('\n', '\r\n'),
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const transport = new CodexTransportAdapter(authStub(), { fetch: vi.fn().mockResolvedValue(new Response(body)) })
    await expect(transport.complete(completion, streamContext)).resolves.toMatchObject({
      content: 'été',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'a' } }],
    })
  })

  it('propagates a reader failure without completing partial tools', async () => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(sse(partialTool)))
        else controller.error(new Error('Connection lost'))
      },
    })
    const transport = new CodexTransportAdapter(authStub(), { fetch: vi.fn().mockResolvedValue(new Response(body)) })
    await expect(transport.complete(completion, streamContext)).rejects.toThrow('Connection lost')
  })
})

describe('CodexTransportAdapter attachments', () => {
  it.each(['system', 'assistant', 'tool'] as const)('refuses attachments on %s messages', async (role) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse({ type: 'response.completed' })))
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock })
    await expect(
      transport.complete(
        {
          messages: [
            {
              role,
              content: 'text',
              attachments: [{ id: 't', filename: 'note.txt', mimeType: 'text/plain', size: 5, data: 'hello' }],
            },
          ],
        },
        streamContext,
      ),
    ).rejects.toThrow(/attachments/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends an image-only message and decodes base64 text documents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse({ type: 'response.completed' })))
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock })
    await transport.complete(
      {
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [
              { id: 'i', filename: 'photo.png', mimeType: 'image/png', size: 3, data: 'data:image/png;base64,YWJj' },
            ],
          },
          {
            role: 'user',
            content: '',
            attachments: [
              {
                id: 't',
                filename: 'data.json',
                mimeType: 'application/json',
                size: 2,
                data: 'data:application/json;base64,e30=',
              },
            ],
          },
        ],
      },
      streamContext,
    )
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)
    expect(body.input[0].content).toContainEqual({ type: 'input_image', image_url: 'data:image/png;base64,YWJj' })
    expect(body.input[1].content).toContainEqual({ type: 'input_text', text: '[File: data.json]\n{}' })
  })
  it('sends image and text attachments alongside the user text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse({ type: 'response.completed' })))
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock })
    await transport.complete(
      {
        messages: [
          {
            role: 'user',
            content: 'Read these',
            attachments: [
              { id: 'i', filename: 'photo.png', mimeType: 'image/png', size: 3, data: 'data:image/png;base64,YWJj' },
              { id: 't', filename: 'note.txt', mimeType: 'text/plain', size: 5, data: 'hello' },
            ],
          },
        ],
      },
      streamContext,
    )
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'Read these' },
      { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
      { type: 'input_text', text: '[File: note.txt]\nhello' },
    ])
  })

  it.each([
    { mimeType: 'application/pdf', data: 'data:application/pdf;base64,YWJj' },
    { mimeType: 'audio/mpeg', data: 'abc' },
    { mimeType: 'image/png', data: '' },
    { mimeType: 'image/png', data: 'https://example.com/private.png' },
  ])('explicitly refuses unsupported or invalid attachments ($mimeType)', async (attachment) => {
    const fetchMock = vi.fn()
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock })
    await expect(
      transport.complete(
        {
          messages: [
            { role: 'user', content: '', attachments: [{ id: 'a', filename: 'attachment', size: 3, ...attachment }] },
          ],
        },
        streamContext,
      ),
    ).rejects.toThrow(/attachment/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('parseWhamUsage', () => {
  it('reads the two metered windows, their lengths and the credits', () => {
    const usage = parseWhamUsage(whamPayload)

    expect(usage?.windows).toEqual([
      { usedPercent: 42, windowMinutes: 300, resetsAt: 1792158000 },
      { usedPercent: 18, windowMinutes: 10080, resetsAt: 1792676400 },
    ])
    expect(usage?.planType).toBe('plus')
    expect(usage?.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' })
  })

  it('ignores a payload that carries no window', () => {
    expect(parseWhamUsage({ rate_limit: {} })).toBeUndefined()
    expect(parseWhamUsage(null)).toBeUndefined()
  })
})

describe('CodexTransportAdapter usage on demand', () => {
  it('asks the backend, so the numbers are there before any message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(whamPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as unknown as typeof fetch })

    const usage = await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' })

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/wham/usage')
    expect(usage?.windows.map((window) => window.usedPercent)).toEqual([42, 18])
  })

  it('reuses the numbers it just read instead of asking again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(whamPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as unknown as typeof fetch })

    await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' })
    await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://chatgpt.com/backend-api/wham/usage',
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    ])
  })

  it('says nothing, and does not throw, when the query is refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as unknown as typeof fetch })

    expect(await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' })).toBeUndefined()
  })

  it('does not ask anything without a credential', async () => {
    const fetchMock = vi.fn()
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as unknown as typeof fetch })

    expect(await transport.getUsage({ providerId: 'p1' })).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches coupons even after a fresh streamed quota and keeps accounts separate', async () => {
    const auth = authStub()
    vi.mocked(auth.getAccessContext).mockImplementation(async (ref) => ({
      headers: { Authorization: `Bearer ${ref}` },
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).includes('/responses'))
        return new Response(
          sse(
            { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 12 } } },
            { type: 'response.completed', response: { id: 'r1' } },
          ),
        )
      if (String(url).endsWith('/rate-limit-reset-credits')) {
        const count = new Headers(options?.headers).get('Authorization') === 'Bearer cred-1' ? 3 : 1
        return new Response(JSON.stringify({ available_count: count, credits: [] }))
      }
      return new Response(JSON.stringify(whamPayload))
    })
    const transport = new CodexTransportAdapter(auth, { fetch: fetchMock as typeof fetch })
    for await (const _event of transport.stream(completion, { providerId: 'p1', credentialRef: 'cred-1' })) {
      /* drain */
    }
    const first = await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' })
    expect(first?.resetCredits?.availableCount).toBe(3)
    expect(first?.windows[0]?.usedPercent).toBe(12)
    const second = await transport.getUsage({ providerId: 'p2', credentialRef: 'cred-2' })
    expect(second?.resetCredits?.availableCount).toBe(1)
    expect(
      (await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' }))?.resetCredits?.availableCount,
    ).toBe(3)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/wham/usage'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/consume'))).toHaveLength(0)
  })

  it('keeps a known coupon count when expiration lookup fails, without inventing zero', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/wham/usage')
        ? new Response(JSON.stringify({ ...whamPayload, rate_limit_reset_credits: { available_count: 3 } }))
        : new Response('', { status: 403 }),
    )
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as typeof fetch })
    expect((await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' }))?.resetCredits).toEqual({
      availableCount: 3,
    })
  })

  it('reports unavailable coupons without hiding working quotas', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/wham/usage')
        ? new Response(JSON.stringify(whamPayload))
        : new Response('', { status: 403 }),
    )
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as typeof fetch })
    const result = await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' })
    expect(result?.resetCredits).toEqual({ availableCount: null })
    expect(result?.windows).toHaveLength(2)
  })
})

describe('parseRateLimitHeaders', () => {
  it('reads the short and the long window from the codex header family', () => {
    const usage = parseRateLimitHeaders(
      new Headers({
        'x-codex-primary-used-percent': '42.5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1792158000',
        'x-codex-secondary-used-percent': '18',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1792676400',
        'x-codex-limit-name': 'Pro',
      }),
    )

    expect(usage?.windows).toEqual([
      { usedPercent: 42.5, windowMinutes: 300, resetsAt: 1792158000 },
      { usedPercent: 18, windowMinutes: 10080, resetsAt: 1792676400 },
    ])
    expect(usage?.planType).toBe('Pro')
  })

  it('ignores a response that carries no rate-limit header', () => {
    expect(parseRateLimitHeaders(new Headers())).toBeUndefined()
  })

  it('keeps a window that only reports its percentage', () => {
    expect(parseRateLimitHeaders(new Headers({ 'x-codex-primary-used-percent': '7' }))?.windows).toEqual([
      { usedPercent: 7 },
    ])
  })
})

describe('parseRateLimitEvent', () => {
  it('reads the codex.rate_limits stream event', () => {
    const usage = parseRateLimitEvent(
      JSON.stringify({
        type: 'codex.rate_limits',
        plan_type: 'plus',
        rate_limits: {
          primary: { used_percent: 61, window_minutes: 300, reset_at: 1792158000 },
          secondary: { used_percent: 9, window_minutes: 10080, reset_at: 1792676400 },
        },
        credits: { has_credits: true, unlimited: false, balance: '12.50' },
      }),
    )

    expect(usage?.windows).toEqual([
      { usedPercent: 61, windowMinutes: 300, resetsAt: 1792158000 },
      { usedPercent: 9, windowMinutes: 10080, resetsAt: 1792676400 },
    ])
    expect(usage?.planType).toBe('plus')
    expect(usage?.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' })
  })

  it('ignores the other stream events', () => {
    expect(parseRateLimitEvent(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }))).toBeUndefined()
  })
})

describe('CodexTransportAdapter usage', () => {
  it('has nothing to report before the first response', async () => {
    const transport = new CodexTransportAdapter(authStub())

    expect(await transport.getUsage({ providerId: 'p1' })).toBeUndefined()
  })

  it('picks the usage up from the stream it just read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          sse(
            { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 12, window_minutes: 300 } } },
            { type: 'response.completed', response: { id: 'r1' } },
          ),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as unknown as typeof fetch })

    for await (const _event of transport.stream(completion, { providerId: 'p1', credentialRef: 'cred-1' })) {
      // drain the stream
    }

    expect((await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' }))?.windows).toEqual([
      { usedPercent: 12, windowMinutes: 300 },
    ])
  })

  it('keeps the usage carried by an error response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('slow down', {
        status: 429,
        headers: { 'x-codex-primary-used-percent': '97', 'x-codex-primary-window-minutes': '300' },
      }),
    )
    const transport = new CodexTransportAdapter(authStub(), { fetch: fetchMock as unknown as typeof fetch })

    const types: string[] = []
    for await (const event of transport.stream(completion, { providerId: 'p1', credentialRef: 'cred-1' })) {
      types.push(event.type)
    }

    expect(types).toContain('error')
    expect((await transport.getUsage({ providerId: 'p1', credentialRef: 'cred-1' }))?.windows[0]?.usedPercent).toBe(97)
  })
})
