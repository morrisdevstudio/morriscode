import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'
import { createProviderManager } from './provider-manager.js'

const chatGptProvider = {
  id: 'chatgpt',
  name: 'ChatGPT Plus / Pro',
  url: 'https://chatgpt.com/backend-api/codex',
  backend: 'openai' as const,
  transportAdapter: 'openai-codex',
  credentialRef: 'cred-1',
  models: [{ id: 'gpt-6-astra', contextWindow: 400000, source: 'user' as const }],
  isActive: true,
  createdAt: new Date().toISOString(),
}

function managerWith(transport: unknown) {
  const config = loadConfig()
  return createProviderManager(
    { ...config, providers: [chatGptProvider as never], defaultModelSelection: 'chatgpt/gpt-6-astra' },
    { adapters: { getTransport: vi.fn(() => transport) } as never },
  )
}

describe('getProviderUsage', () => {
  it('hands back what the provider transport observed', async () => {
    const manager = managerWith({
      id: 'openai-codex',
      getUsage: vi.fn(async () => ({
        windows: [
          { usedPercent: 42, windowMinutes: 300 },
          { usedPercent: 18, windowMinutes: 10080 },
        ],
        observedAt: 1,
      })),
    })

    expect((await manager.getProviderUsage('chatgpt'))?.windows.map((window) => window.usedPercent)).toEqual([42, 18])
  })

  it('says nothing when the provider does not meter usage', async () => {
    const manager = managerWith({ id: 'openai-codex' })

    expect(await manager.getProviderUsage('chatgpt')).toBeUndefined()
  })

  it('says nothing for an unknown provider', async () => {
    const manager = managerWith({ id: 'openai-codex', getUsage: vi.fn() })

    expect(await manager.getProviderUsage('nope')).toBeUndefined()
  })

  it('reports nothing, and keeps working, when the transport fails', async () => {
    const manager = managerWith({
      id: 'openai-codex',
      getUsage: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    expect(await manager.getProviderUsage('chatgpt')).toBeUndefined()
  })
})
