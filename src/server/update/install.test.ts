import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectInstallFlavor,
  inferReleaseRoot,
  readCurrentRelease,
  resolveVersionDir,
  writeCurrentRelease,
} from './install.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'morriscode-update-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('install flavor', () => {
  it('prefers the launcher environment', () => {
    expect(detectInstallFlavor({ MORRISCODE_INSTALL_FLAVOR: 'release' }, '/tmp/app/dist/cli/index.js')).toBe('release')
    expect(detectInstallFlavor({ MORRISCODE_RELEASE_ROOT: 'C:/app' }, '/tmp/app/dist/cli/index.js')).toBe('release')
  })

  it('recognises a release path without environment variables', () => {
    expect(detectInstallFlavor({}, 'C:\\app\\releases\\0.2.0\\dist\\cli\\index.js')).toBe('release')
    expect(inferReleaseRoot('C:\\app\\releases\\0.2.0\\dist\\cli\\index.js')).toBe('C:\\app')
  })

  it('keeps development and npm installs separate', () => {
    expect(detectInstallFlavor({ NODE_ENV: 'development' }, 'D:/repo/dist/cli/index.js')).toBe('development')
    expect(detectInstallFlavor({}, 'D:/repo/dist/cli/index.js')).toBe('npm')
  })
})

describe('current release pointer', () => {
  it('round-trips a pointer and keeps the pending update', async () => {
    const root = await makeRoot()
    await writeCurrentRelease(root, {
      schemaVersion: 1,
      version: '0.2.0',
      dir: join('releases', '0.2.0'),
      previous: { version: '0.1.0', dir: join('releases', '0.1.0') },
      pending: { fromVersion: '0.1.0', backupDir: 'update-backups/one', startedAt: '2026-10-23T00:00:00.000Z' },
      updatedAt: '2026-10-23T00:00:00.000Z',
    })

    const stored = await readCurrentRelease(root)
    expect(stored?.version).toBe('0.2.0')
    expect(stored?.pending?.fromVersion).toBe('0.1.0')
    expect((await readFile(join(root, 'current.json'), 'utf-8')).trim().startsWith('{')).toBe(true)
  })

  it('rejects a release directory outside the root', () => {
    expect(() => resolveVersionDir('C:/app', '../evil')).toThrow(/escapes the install root/)
    expect(resolveVersionDir('C:/app', 'releases/0.2.0')).toMatch(/releases/)
  })
})
