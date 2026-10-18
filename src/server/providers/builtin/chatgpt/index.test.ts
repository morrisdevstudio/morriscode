import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderPluginRegistry } from '../../../../provider/index.js'
import { CHATGPT_BUILTIN, register } from './index.js'

function fakeRegistry(configDirectory: string): ProviderPluginRegistry {
  return {
    runtime: { mode: 'production', configDirectory },
    registerAuth: vi.fn(),
    registerTransport: vi.fn(),
    registerPreset: vi.fn(),
  }
}

describe('ChatGPT built-in provider', () => {
  it('registers auth, transport and preset through the public plugin API', async () => {
    const registry = fakeRegistry(await mkdtemp(join(tmpdir(), 'morriscode-chatgpt-')))

    await register(registry)

    expect(registry.registerAuth).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai-account' }))
    expect(registry.registerTransport).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai-codex' }))
    expect(registry.registerPreset).toHaveBeenCalledWith(expect.objectContaining({ id: 'chatgpt' }))
  })

  it('points the preset at the ChatGPT backend and requires auth', async () => {
    const registry = fakeRegistry(await mkdtemp(join(tmpdir(), 'morriscode-chatgpt-')))

    await register(registry)

    expect(registry.registerPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chatgpt',
        requiresAuth: true,
        authAdapter: 'openai-account',
        transportAdapter: 'openai-codex',
        defaults: expect.objectContaining({ url: 'https://chatgpt.com/backend-api/codex', backend: 'openai' }),
      }),
    )
  })

  it('describes itself as a built-in plugin', () => {
    expect(CHATGPT_BUILTIN.id).toBe('morriscode-chatgpt')
    expect(CHATGPT_BUILTIN.presetIds).toEqual(['chatgpt'])
    expect(CHATGPT_BUILTIN.capabilities).toContain('providers')
  })
})
