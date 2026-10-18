import { beforeEach, describe, expect, it } from 'vitest'
import { clearCodexModelsCache, fetchCodexModels } from './models-dev.js'

/** A trimmed models.dev payload: the OpenAI models the catalog has to sift through. */
const payload = {
  openai: {
    models: {
      'gpt-4.1': { id: 'gpt-4.1', name: 'GPT-4.1' },
      'gpt-5.2-codex': { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
      'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' },
      'gpt-5.5-pro': { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' },
      'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      'gpt-6-astra': { id: 'gpt-6-astra', name: 'GPT-6 Astra', limit: { context: 400000 } },
      'gpt-4o-legacy': { id: 'gpt-4o-legacy', name: 'GPT-4o', status: 'deprecated' },
    },
  },
}

const fetcher = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch

beforeEach(() => {
  clearCodexModelsCache()
})

describe('fetchCodexModels', () => {
  it('lists every model generation the backend serves, not only the gpt-5 family', async () => {
    const ids = (await fetchCodexModels(fetcher)).map((model) => model.id)

    expect(ids).toContain('gpt-6-astra')
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('gpt-5.2-codex')
  })

  it('keeps hiding models the ChatGPT backend does not serve', async () => {
    const ids = (await fetchCodexModels(fetcher)).map((model) => model.id)

    expect(ids).not.toContain('gpt-4.1')
    expect(ids).not.toContain('gpt-5.5-pro')
    expect(ids).not.toContain('gpt-4o-legacy')
  })

  it('carries capabilities through for a newer model', async () => {
    const model = (await fetchCodexModels(fetcher)).find((entry) => entry.id === 'gpt-6-astra')

    expect(model?.contextWindow).toBe(400000)
  })
})
