import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'
import { createProviderManager } from './provider-manager.js'

const catalog = [
  { id: 'gpt-6-astra', contextWindow: 400000, source: 'backend' as const },
  { id: 'gpt-5.6-sol', contextWindow: 200000, source: 'backend' as const },
  { id: 'gpt-5.4', contextWindow: 200000, source: 'backend' as const },
]

function managerWith(models: unknown[]) {
  const config = loadConfig()
  const provider = {
    id: 'chatgpt',
    name: 'ChatGPT Plus / Pro',
    url: 'https://chatgpt.com/backend-api/codex',
    backend: 'openai' as const,
    transportAdapter: 'openai-codex',
    credentialRef: 'cred-1',
    models,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const adapters = {
    getTransport: vi.fn(() => ({ id: 'openai-codex', listModels: vi.fn(async () => catalog) })),
  }
  return createProviderManager(
    { ...config, providers: [provider as never], defaultModelSelection: 'chatgpt/gpt-6-astra' },
    { adapters: adapters as never },
  )
}

describe('refreshProviderModels', () => {
  it('keeps a model the user turned off turned off', async () => {
    const manager = managerWith([
      { id: 'gpt-6-astra', contextWindow: 400000, source: 'user', selected: true },
      { id: 'gpt-5.6-sol', contextWindow: 200000, source: 'user', selected: false },
    ])

    await manager.refreshProviderModels('chatgpt')

    const stored = manager.getProviders().find((p) => p.id === 'chatgpt')!.models
    expect(stored.find((model) => model.id === 'gpt-5.6-sol')?.selected).toBe(false)
  })
})
