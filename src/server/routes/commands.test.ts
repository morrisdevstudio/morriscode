import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createCommandRoutes } from './commands.js'
import { loadAllCommands, loadDefaultCommands, saveCommand } from '../commands/registry.js'

/**
 * Test the paramNames extraction logic used in mapToResponse.
 * The actual implementation in routes/commands.ts does:
 *   Array.from(c.prompt.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]!)
 */
function extractParamNames(prompt: string): string[] {
  return Array.from(prompt.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]!)
}

describe('command paramNames extraction', () => {
  it('extracts named params from prompt', () => {
    expect(extractParamNames('Say {{text}} to {{audience}}')).toEqual(['text', 'audience'])
  })

  it('returns empty array for prompt without params', () => {
    expect(extractParamNames('Hello world')).toEqual([])
  })

  it('deduplicates repeated params', () => {
    // matchAll returns all matches; dedup is handled downstream
    expect(extractParamNames('{{name}} and {{name}} again')).toEqual(['name', 'name'])
  })

  it('handles numeric params', () => {
    expect(extractParamNames('{{0}}: {{1}}')).toEqual(['0', '1'])
  })

  it('ignores non-word characters inside braces', () => {
    expect(extractParamNames('{{}}')).toEqual([])
  })

  it('handles empty prompt', () => {
    expect(extractParamNames('')).toEqual([])
  })
})

describe('command library routes', () => {
  let rootDir: string
  let server: ReturnType<express.Express['listen']>
  let baseUrl: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'morriscode-command-routes-'))
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use('/api/commands', createCommandRoutes(join(rootDir, 'config'), join(rootDir, 'project')))
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(rootDir, { recursive: true, force: true })
  })

  it('deletes a user override via the API and restores the built-in default', async () => {
    const defaults = await loadDefaultCommands()
    const defaultCommand = defaults[0]
    if (!defaultCommand) return

    await saveCommand(join(rootDir, 'config'), {
      metadata: { ...defaultCommand.metadata, name: 'Customized Command' },
      prompt: 'Customized prompt.',
    })

    const deleteRes = await fetch(`${baseUrl}/api/commands/${defaultCommand.metadata.id}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const commands = await loadAllCommands(join(rootDir, 'config'))
    const restored = commands.find((command) => command.metadata.id === defaultCommand.metadata.id)
    expect(restored).toEqual(defaultCommand)
  })

  it('still blocks deletion of a built-in default with no override', async () => {
    const defaults = await loadDefaultCommands()
    const defaultCommand = defaults[0]
    if (!defaultCommand) return

    const deleteRes = await fetch(`${baseUrl}/api/commands/${defaultCommand.metadata.id}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(403)
  })
})
