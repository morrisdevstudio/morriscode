import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { mergeConfigs, refreshSessionsDatabase } from './migrate-from-openfox.mjs'

describe('development migration CLI', () => {
  it('copies the production OpenFox snapshot into dev without touching MorrisCode production', async () => {
    const root = await mkdtemp(join(tmpdir(), 'morriscode-dev-migration-'))
    const configRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    const sourceConfig =
      process.platform === 'darwin'
        ? join(root, 'Library', 'Application Support', 'openfox')
        : join(configRoot, 'openfox')
    const sourceData = process.platform === 'darwin' ? sourceConfig : join(dataRoot, 'openfox')
    const destConfig =
      process.platform === 'darwin'
        ? join(root, 'Library', 'Application Support', 'morriscode-dev')
        : join(configRoot, 'morriscode-dev')
    const destData = process.platform === 'darwin' ? destConfig : join(dataRoot, 'morriscode-dev')
    try {
      await mkdir(configRoot, { recursive: true })
      await mkdir(dataRoot, { recursive: true })
      await mkdir(sourceConfig, { recursive: true })
      await mkdir(sourceData, { recursive: true })
      const sourceJson = JSON.stringify({ providers: [{ id: 'real-provider', models: [{ id: 'real-model' }] }] })
      await writeFile(join(sourceConfig, 'config.json'), sourceJson)
      makeSessionsDb(join(sourceData, 'sessions.db'), [{ id: 'real-session', updatedAt: '2026-10-16' }])
      await promisify(execFile)(process.execPath, ['scripts/migrate-from-openfox.mjs', '--dev'], {
        env: {
          ...process.env,
          APPDATA: configRoot,
          LOCALAPPDATA: dataRoot,
          XDG_CONFIG_HOME: configRoot,
          XDG_DATA_HOME: dataRoot,
          HOME: root,
        },
      })
      expect(JSON.parse(await readFile(join(destConfig, 'config.json'), 'utf8')).providers[0].id).toBe('real-provider')
      expect(sessionIds(join(destData, 'sessions.db'))).toEqual(['real-session'])
      expect(await readFile(join(sourceConfig, 'config.json'), 'utf8')).toBe(sourceJson)
      expect(sessionIds(join(sourceData, 'sessions.db'))).toEqual(['real-session'])
      expect(await readdir(configRoot)).not.toContain('morriscode')
      expect(await readdir(dataRoot)).not.toContain('morriscode')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

interface ProviderShape {
  id?: string
  name?: string
  models?: Array<{ id?: string }>
}

interface ConfigShape {
  providers?: ProviderShape[]
  [key: string]: unknown
}

interface MergeResult {
  config: ConfigShape
  filledKeys: string[]
  addedModels: Array<{ provider: string; ids: string[] }>
  addedProviders: string[]
}

const merge = mergeConfigs as unknown as (dest: ConfigShape, source: ConfigShape) => MergeResult
const refresh = refreshSessionsDatabase as unknown as (
  source: string,
  dest: string,
  dryRun: boolean,
  log?: (line: string) => void,
) => Promise<void>

function providerNames(config: ConfigShape): string[] {
  return (config.providers ?? []).map((provider) => provider.name ?? provider.id ?? '?')
}

function modelIds(config: ConfigShape, providerName: string): Array<string | undefined> {
  const provider = (config.providers ?? []).find((candidate) => candidate.name === providerName)
  return (provider?.models ?? []).map((model) => model.id)
}

function makeSessionsDb(path: string, sessions: Array<{ id: string; updatedAt: string }>): void {
  const db = new Database(path)
  db.exec('create table sessions (id text primary key, title text, updated_at text)')
  const insert = db.prepare('insert into sessions (id, title, updated_at) values (?, ?, ?)')
  for (const session of sessions) insert.run(session.id, `title ${session.id}`, session.updatedAt)
  db.close()
}

function sessionIds(path: string): string[] {
  const db = new Database(path, { readonly: true })
  try {
    return db
      .prepare('select id from sessions order by id')
      .all()
      .map((row) => String(row.id))
  } finally {
    db.close()
  }
}

describe('mergeConfigs', () => {
  it('brings back models and providers OpenFox has, without dropping MorrisCode additions', () => {
    const dest: ConfigShape = {
      providers: [
        { id: 'shared', name: 'command code', models: [{ id: 'a' }, { id: 'morriscode-only' }] },
        { id: 'vllm', name: 'vLLM', models: [] },
      ],
      server: { port: 10369, host: '0.0.0.0' },
    }
    const source: ConfigShape = {
      providers: [
        { id: 'shared', name: 'command code', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        { id: 'chatgpt', name: 'ChatGPT Plus / Pro', models: [{ id: 'gpt-x' }] },
      ],
      server: { port: 9999 },
      activeWorkflowId: 'wf-1',
    }

    const { config, filledKeys, addedModels, addedProviders } = merge(dest, source)

    expect(modelIds(config, 'command code')).toEqual(['a', 'morriscode-only', 'b', 'c'])
    expect(providerNames(config)).toEqual(['command code', 'vLLM', 'ChatGPT Plus / Pro'])
    expect(addedModels).toEqual([{ provider: 'command code', ids: ['b', 'c'] }])
    expect(addedProviders).toEqual(['ChatGPT Plus / Pro'])
    expect(filledKeys).toEqual(['activeWorkflowId'])
    // MorrisCode's own server settings win over OpenFox's.
    expect(config['server']).toEqual({ port: 10369, host: '0.0.0.0' })
  })

  it('reports nothing to do when OpenFox has no news', () => {
    const config: ConfigShape = { providers: [{ id: 'a', name: 'A', models: [{ id: 'm' }] }] }
    const result = merge(config, { providers: [{ id: 'a', name: 'A', models: [{ id: 'm' }] }] })
    expect(result.addedModels).toEqual([])
    expect(result.addedProviders).toEqual([])
    expect(result.config.providers).toHaveLength(1)
  })
})

describe('refreshSessionsDatabase', () => {
  let dir: string
  let source: string
  let dest: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'morriscode-migrate-test-'))
    source = join(dir, 'openfox.db')
    dest = join(dir, 'morriscode.db')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('replaces the MorrisCode copy with the full OpenFox history and keeps a backup', async () => {
    makeSessionsDb(source, [
      { id: 's1', updatedAt: '2026-10-01T10:00:00Z' },
      { id: 's2', updatedAt: '2026-10-02T10:00:00Z' },
      { id: 's3', updatedAt: '2026-10-14T16:22:00Z' },
    ])
    makeSessionsDb(dest, [
      { id: 's1', updatedAt: '2026-10-01T10:00:00Z' },
      { id: 's2', updatedAt: '2026-10-02T10:00:00Z' },
    ])

    const lines: string[] = []
    await refresh(source, dest, false, (line) => lines.push(line))

    expect(sessionIds(dest)).toEqual(['s1', 's2', 's3'])
    expect(lines.join('\n')).toContain('refreshed: 3 session(s)')

    const backups = (await readdir(dir)).filter((name) => name.startsWith('morriscode.db.pre-migrate-'))
    expect(backups).toHaveLength(1)
    expect(sessionIds(join(dir, backups[0]!))).toEqual(['s1', 's2'])
  })

  it('warns when MorrisCode holds sessions OpenFox does not have', async () => {
    makeSessionsDb(source, [{ id: 's1', updatedAt: '2026-10-01T10:00:00Z' }])
    makeSessionsDb(dest, [
      { id: 's1', updatedAt: '2026-10-01T10:00:00Z' },
      { id: 'local-only', updatedAt: '2026-10-05T10:00:00Z' },
    ])

    const lines: string[] = []
    await refresh(source, dest, false, (line) => lines.push(line))

    expect(lines.join('\n')).toContain('1 session(s) exist only in MorrisCode (local-only')
    expect(sessionIds(dest)).toEqual(['s1'])
    const backups = (await readdir(dir)).filter((name) => name.startsWith('morriscode.db.pre-migrate-'))
    expect(sessionIds(join(dir, backups[0]!))).toEqual(['local-only', 's1'])
  })

  it('leaves everything untouched in dry-run mode', async () => {
    makeSessionsDb(source, [
      { id: 's1', updatedAt: '2026-10-01T10:00:00Z' },
      { id: 's2', updatedAt: '2026-10-02T10:00:00Z' },
    ])
    makeSessionsDb(dest, [{ id: 's1', updatedAt: '2026-10-01T10:00:00Z' }])

    const lines: string[] = []
    await refresh(source, dest, true, (line) => lines.push(line))

    expect(sessionIds(dest)).toEqual(['s1'])
    expect(lines.join('\n')).toContain('would refresh')
    expect((await readdir(dir)).filter((name) => name.includes('pre-migrate'))).toHaveLength(0)
  })
})
