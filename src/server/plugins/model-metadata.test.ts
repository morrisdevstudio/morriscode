import { afterEach, describe, expect, it } from 'vitest'
import type { ModelConfig, Provider } from '../../shared/types.js'
import {
  enrichModelWithPluginMetadata,
  enrichProviderWithPluginMetadata,
  setPluginModelMetadataProviders,
} from './model-metadata.js'

const model: ModelConfig = { id: 'model', contextWindow: 1000, source: 'backend' }
const provider: Provider = {
  id: 'provider',
  name: 'Provider',
  url: 'http://localhost',
  backend: 'openai',
  models: [model],
  isActive: true,
  createdAt: '2026-01-01',
}

afterEach(() => setPluginModelMetadataProviders([]))

describe('plugin metadata enrichment', () => {
  it('returns the original objects when plugins contribute no metadata', async () => {
    setPluginModelMetadataProviders([{ id: 'empty', getMetadata: () => undefined }])
    expect(await enrichModelWithPluginMetadata(provider.id, model)).toBe(model)
    expect(await enrichProviderWithPluginMetadata(provider)).toBe(provider)
  })

  it('merges extra fields and appends badges in order while ignoring failed contributors', async () => {
    const first = { label: { en: 'First', fr: 'Premier' } }
    const second = { label: { en: 'Second', fr: 'Deuxième' } }
    const firstMetadata = { extra: { kept: true, replaced: 1 }, badges: [first], vision: true }
    const secondMetadata = { extra: { replaced: 2 }, badges: [second], vision: false }
    setPluginModelMetadataProviders([
      { id: 'first', getMetadata: () => firstMetadata, getProviderMetadata: () => firstMetadata },
      {
        id: 'failed',
        getMetadata: () => {
          throw new Error('failed')
        },
        getProviderMetadata: () => {
          throw new Error('failed')
        },
      },
      { id: 'second', getMetadata: () => secondMetadata, getProviderMetadata: () => secondMetadata },
    ])
    const common = { extra: { kept: true, replaced: 2 }, badges: [first, second] }
    expect((await enrichModelWithPluginMetadata(provider.id, model)).pluginMetadata).toEqual({
      ...common,
      vision: false,
    })
    expect((await enrichProviderWithPluginMetadata(provider)).pluginMetadata).toEqual(common)
    expect(model.pluginMetadata).toBeUndefined()
    expect(provider.pluginMetadata).toBeUndefined()
    expect(firstMetadata.badges).toEqual([first])
  })
})
