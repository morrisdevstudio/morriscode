import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from './api'
import { clearCache } from './resourceCache'
import {
  configResource,
  normalizeServerNetwork,
  providerModelsResource,
  providersResource,
  readConfig,
  updateServerNetwork,
} from './resources'

vi.mock('./api', () => ({
  authFetch: vi.fn(),
}))

function jsonResponse(data: unknown): Response {
  return { ok: true, json: () => Promise.resolve(data) } as unknown as Response
}

describe('providersResource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
  })

  it('uses a single global key', () => {
    expect(providersResource.keyOf()).toBe('providers:list')
  })

  it('fetches the providers list and active id from the global endpoint', async () => {
    vi.mocked(authFetch).mockResolvedValue(
      jsonResponse({ providers: [{ id: 'ollama', name: 'Ollama', models: [] }], activeProviderId: 'ollama' }),
    )
    const data = await providersResource.refresh()
    expect(authFetch).toHaveBeenCalledWith('/api/providers')
    expect(data?.providers[0]?.id).toBe('ollama')
    expect(data?.activeProviderId).toBe('ollama')
  })

  it('normalizes a missing providers field to an empty list', async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse({}))
    const data = await providersResource.refresh()
    expect(data?.providers).toEqual([])
    expect(data?.activeProviderId).toBeNull()
  })
})

describe('providerModelsResource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
  })

  it('keys per provider id so refreshing one provider never touches another', () => {
    expect(providerModelsResource.keyOf('a')).toBe('provider-models:a')
    expect(providerModelsResource.keyOf('b')).toBe('provider-models:b')
    expect(providerModelsResource.keyOf('a')).not.toBe(providerModelsResource.keyOf('b'))
  })

  it('fetches models from the per-provider endpoint', async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse({ models: [{ id: 'qwen', name: 'Qwen' }] }))
    const data = await providerModelsResource.refresh('ollama')
    expect(authFetch).toHaveBeenCalledWith('/api/providers/ollama/models')
    expect(data?.models[0]?.id).toBe('qwen')
  })
})

describe('configResource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
  })

  it('uses a single global runtime key', () => {
    expect(configResource.keyOf()).toBe('config:runtime')
  })

  it('fetches the runtime selection from /api/config', async () => {
    vi.mocked(authFetch).mockResolvedValue(
      jsonResponse({ version: '2.0.0', defaultModelSelection: 'ollama/qwen', workdir: '/repo' }),
    )
    const data = await configResource.refresh()
    expect(authFetch).toHaveBeenCalledWith('/api/config')
    expect(data?.version).toBe('2.0.0')
    expect(data?.defaultModelSelection).toBe('ollama/qwen')
    expect(readConfig()?.workdir).toBe('/repo')
  })

  it('normalizes missing selection fields', async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse({}))
    const data = await configResource.refresh()
    expect(data).toEqual({
      version: null,
      model: null,
      maxContext: 200000,
      llmUrl: null,
      llmStatus: 'unknown',
      backend: 'unknown',
      defaultModelSelection: null,
      platform: null,
      workdir: null,
      visionFallback: null,
      locale: 'automatic',
      serverNetwork: null,
    })
  })
})

describe('serverNetwork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
  })

  it('normalizes the LAN/HTTPS block reported by /api/config', async () => {
    vi.mocked(authFetch).mockResolvedValue(
      jsonResponse({
        serverNetwork: {
          host: '0.0.0.0',
          port: 10369,
          https: true,
          urls: ['https://192.168.1.23:10369'],
          certificatePath: '/cfg/certs/server.crt',
          certificateGenerated: true,
        },
      }),
    )

    const data = await configResource.refresh()
    expect(data?.serverNetwork).toEqual({
      host: '0.0.0.0',
      port: 10369,
      https: true,
      urls: ['https://192.168.1.23:10369'],
      certificatePath: '/cfg/certs/server.crt',
      certificateGenerated: true,
    })
  })

  it('drops a malformed block and non-string urls instead of rendering them', () => {
    expect(normalizeServerNetwork('nope')).toBeNull()
    expect(normalizeServerNetwork({ urls: ['ok', 3, null] })?.urls).toEqual(['ok'])
  })

  it('persists the settings and writes the saved values into the cache', async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse({}))
    await configResource.refresh()

    vi.mocked(authFetch).mockResolvedValue(
      jsonResponse({
        restartRequired: true,
        serverNetwork: { host: '0.0.0.0', port: 10369, https: true, urls: ['https://192.168.1.23:10369'] },
      }),
    )

    const result = await updateServerNetwork({ host: '0.0.0.0', https: true })

    expect(authFetch).toHaveBeenCalledWith('/api/config/network', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '0.0.0.0', https: true }),
    })
    expect(result.restartRequired).toBe(true)
    expect(readConfig()?.serverNetwork?.https).toBe(true)
    expect(readConfig()?.serverNetwork?.urls).toEqual(['https://192.168.1.23:10369'])
  })

  it('reports a rejected save instead of claiming it stuck', async () => {
    vi.mocked(authFetch).mockResolvedValue({ ok: false, status: 500 } as unknown as Response)
    await expect(updateServerNetwork({ https: true })).rejects.toThrow(/500/)
  })
})
