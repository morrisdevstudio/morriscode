import { describe, expect, it } from 'vitest'
import type { Provider } from '../../../../shared/types.js'
import { fetchCommandCodeUsage, isCommandCodeProvider } from './usage.js'

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'cmd',
    name: 'command code',
    url: 'https://api.commandcode.ai/provider/v1',
    backend: 'openai',
    apiKey: 'sk-test',
    models: [],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Provider
}

function recording(routes: Record<string, unknown>) {
  const calls: string[] = []
  const request = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    const match = Object.keys(routes).find((key) => url.includes(key))
    if (!match) return new Response('missing', { status: 404 })
    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { request, calls }
}

const happyRoutes = {
  '/alpha/whoami': { data: { org: { id: 'org-1' } } },
  '/alpha/billing/credits': {
    data: {
      windowLimits: {
        fiveHour: { used: 32, cap: 100, resetAt: 1792158000 },
        weekly: { used: 41, cap: 100 },
      },
    },
  },
}

describe('isCommandCodeProvider', () => {
  it('matches the canonical host only', () => {
    expect(isCommandCodeProvider(provider())).toBe(true)
    expect(isCommandCodeProvider(provider({ url: 'https://api.commandcode.ai.evil.test/v1' }))).toBe(false)
    expect(isCommandCodeProvider(provider({ url: 'https://api.commandcode.ai:8443/v1' }))).toBe(false)
    expect(isCommandCodeProvider(provider({ url: 'not a url' }))).toBe(false)
  })
})

describe('fetchCommandCodeUsage', () => {
  it('reads the 5-hour and weekly windows', async () => {
    const { request } = recording(happyRoutes)

    const usage = await fetchCommandCodeUsage(provider(), request)

    expect(usage?.windows).toEqual([
      { usedPercent: 32, resetsAt: 1792158000, windowMinutes: 300 },
      { usedPercent: 41, windowMinutes: 10080 },
    ])
  })

  it('passes the org id to the credits call, on the canonical host only', async () => {
    const { request, calls } = recording(happyRoutes)

    await fetchCommandCodeUsage(provider(), request)

    expect(calls.some((url) => url.includes('orgId=org-1'))).toBe(true)
    expect(calls.every((url) => url.startsWith('https://api.commandcode.ai/'))).toBe(true)
  })

  it('stays quiet when the plan reports no window', async () => {
    const { request } = recording({ '/alpha/billing/credits': { data: { credits: {} } } })

    expect(await fetchCommandCodeUsage(provider(), request)).toBeUndefined()
  })

  it('never releases the key to a look-alike host', async () => {
    const { request, calls } = recording(happyRoutes)

    expect(
      await fetchCommandCodeUsage(provider({ url: 'https://api.commandcode.ai.evil.test/v1' }), request),
    ).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('says nothing when the provider has no key', async () => {
    const { request, calls } = recording(happyRoutes)

    expect(await fetchCommandCodeUsage(provider({ apiKey: undefined }), request)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('says nothing when the endpoint refuses', async () => {
    const { request } = recording({ '/alpha/whoami': { data: {} } })

    expect(await fetchCommandCodeUsage(provider(), request)).toBeUndefined()
  })
})
