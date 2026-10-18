import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, initDatabase } from '../db/index.js'
import { loadConfig } from '../config.js'
import { setSetting } from '../db/settings.js'
import { PluginHost } from './host.js'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function makeHost(configDirectory: string): PluginHost {
  return new PluginHost({
    configDirectory,
    mode: 'production',
    logger,
    cwd: join(configDirectory, 'no-node-modules'),
  })
}

/** Writes an installed plugin that registers whatever `body` contributes. */
async function writeInstalledPlugin(configDirectory: string, name: string, body: string): Promise<void> {
  const dir = join(configDirectory, 'plugins', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      openfox: { apiVersion: 1, entry: 'index.js', displayName: 'ChatGPT' },
    }),
  )
  await writeFile(join(dir, 'index.js'), `export function register(registry) { ${body} }`)
}

describe('built-in provider plugins', () => {
  let configDirectory: string

  beforeEach(async () => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    configDirectory = await mkdtemp(join(tmpdir(), 'morriscode-builtin-'))
  })

  afterEach(async () => {
    closeDatabase()
    await rm(configDirectory, { recursive: true, force: true })
  })

  it('provides the ChatGPT preset and adapters without an installed package', async () => {
    const host = makeHost(configDirectory)
    await host.start()

    const preset = host.registry.getPresets().find((entry) => entry.id === 'chatgpt')

    expect(preset).toBeDefined()
    expect(preset?.authAdapter).toBe('openai-account')
    expect(host.registry.getAuth('openai-account')).toBeDefined()
    expect(host.registry.getTransport('openai-codex')).toBeDefined()
  })

  it('keeps the built-in out of installed plugins while retaining diagnostics', async () => {
    const host = makeHost(configDirectory)
    await host.start()

    expect(host.getPlugins().some((entry) => entry.id === 'morriscode-chatgpt')).toBe(false)
    const plugin = host.getDiagnostics().find((entry) => entry.packageName === 'morriscode-chatgpt')

    expect(plugin?.loaded).toBe(true)
    expect(plugin?.enabled).toBe(true)
    expect(plugin?.source).toBe('builtin')
    expect(plugin?.contributions.presets).toBe(1)
  })

  it('takes over from the installed plugin it supersedes', async () => {
    await writeInstalledPlugin(configDirectory, 'openfox-chatgpt', "registry.registerAuth({ id: 'openai-account' })")
    const host = makeHost(configDirectory)
    await host.start()

    expect(host.registry.getPluginIdFor('auth', 'openai-account')).toBe('morriscode-chatgpt')
    expect(host.registry.getTransport('openai-codex')).toBeDefined()
    const replaced = host.getPlugins().find((entry) => entry.id === 'openfox-chatgpt')
    expect(replaced?.enabled).toBe(false)
    expect(replaced?.error).toContain('Replaced by the built-in provider')
  })

  it('backs off with an error when another plugin owns the adapter id', async () => {
    await writeInstalledPlugin(configDirectory, 'other-plugin', "registry.registerAuth({ id: 'openai-account' })")
    const host = makeHost(configDirectory)
    await host.start()

    const builtIn = host.getDiagnostics().find((entry) => entry.packageName === 'morriscode-chatgpt')
    expect(builtIn?.loaded).toBe(false)
    expect(builtIn?.error).toContain('already registered')
    expect(host.registry.getTransport('openai-codex')).toBeUndefined()
    expect(host.registry.getPresets().some((preset) => preset.id === 'chatgpt')).toBe(false)
  })

  it('cannot be managed as an installed plugin', async () => {
    const host = makeHost(configDirectory)
    await host.start()

    await expect(host.enable('morriscode-chatgpt')).rejects.toThrow('built-in provider')
    await expect(host.disable('morriscode-chatgpt')).rejects.toThrow('built-in provider')
    await expect(host.uninstall('morriscode-chatgpt')).rejects.toThrow('built-in provider')
    await expect(host.reinstall('morriscode-chatgpt')).rejects.toThrow('built-in provider')
    expect(host.registry.getPresets().find((entry) => entry.id === 'chatgpt')).toBeDefined()
    expect(host.registry.getTransport('openai-codex')).toBeDefined()
  })

  it('loads the built-in even when an old plugin preference disabled it', async () => {
    setSetting('plugin.disabled', JSON.stringify(['morriscode-chatgpt']))
    const host = makeHost(configDirectory)
    await host.start()
    expect(host.registry.getPresets().find((entry) => entry.id === 'chatgpt')).toBeDefined()
    expect(host.registry.getAuth('openai-account')).toBeDefined()
    expect(host.getDiagnostics().find((entry) => entry.packageName === 'morriscode-chatgpt')?.enabled).toBe(true)
  })
})
