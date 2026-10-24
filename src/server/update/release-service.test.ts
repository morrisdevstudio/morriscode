import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateReleaseKeyPair, signManifest } from './signing.js'
import { ReleaseUpdateService } from './release-service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'morriscode-release-service-'))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Build a minimal signed release payload the service can verify without network access. */
function signedRelease(version = '0.2.0') {
  const packageBytes = Buffer.from('release archive content')
  const keys = generateReleaseKeyPair()
  const filename = `morriscode-${version}-win32-x64.zip`
  const manifest = {
    schemaVersion: 1 as const,
    keyId: 'test',
    version,
    tag: `v${version}`,
    commit: 'abcdef1',
    publishedAt: '2026-10-23T00:00:00.000Z',
    assets: [
      {
        platform: 'win32' as const,
        arch: 'x64' as const,
        filename,
        size: packageBytes.length,
        sha256: sha256(packageBytes),
      },
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const signature = signManifest(manifestBytes, keys.privateKeyPem)
  const release = {
    tagName: `v${version}`,
    name: version,
    body: 'Release notes',
    htmlUrl: `https://github.com/morrisdevstudio/morriscode-releases/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: 'manifest.json', size: manifestBytes.length, browserDownloadUrl: 'https://github.com/manifest.json' },
      {
        name: 'manifest.json.sig',
        size: signature.length,
        browserDownloadUrl: 'https://github.com/manifest.json.sig',
      },
      { name: filename, size: packageBytes.length, browserDownloadUrl: 'https://github.com/package.zip' },
    ],
  }
  return { version, packageBytes, keys, manifest, manifestBytes, signature, release, filename }
}

describe('release update service', () => {
  it('downloads, verifies and stages a signed release before applying it', async () => {
    const root = await makeRoot()
    const configDir = await makeRoot()
    const packageBytes = Buffer.from('release archive content')
    const keys = generateReleaseKeyPair()
    const manifest = {
      schemaVersion: 1,
      keyId: 'test',
      version: '0.2.0',
      tag: 'v0.2.0',
      commit: 'abcdef1',
      publishedAt: '2026-10-23T00:00:00.000Z',
      assets: [
        {
          platform: 'win32',
          arch: 'x64',
          filename: 'morriscode-0.2.0-win32-x64.zip',
          size: packageBytes.length,
          sha256: sha256(packageBytes),
        },
      ],
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const signature = signManifest(manifestBytes, keys.privateKeyPem)
    const release = {
      tagName: 'v0.2.0',
      name: '0.2.0',
      body: 'Release notes',
      htmlUrl: 'https://github.com/morrisdevstudio/morriscode-releases/releases/tag/v0.2.0',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'manifest.json', size: manifestBytes.length, browserDownloadUrl: 'https://github.com/manifest.json' },
        {
          name: 'manifest.json.sig',
          size: signature.length,
          browserDownloadUrl: 'https://github.com/manifest.json.sig',
        },
        {
          name: manifest.assets[0]!.filename,
          size: packageBytes.length,
          browserDownloadUrl: 'https://github.com/package.zip',
        },
      ],
    }

    const service = new ReleaseUpdateService({
      root,
      currentVersion: '0.1.0',
      configDir,
      databasePath: join(root, 'sessions.db'),
      platform: 'win32',
      arch: 'x64',
      env: {},
      onRestart: () => undefined,
      getAutoUpdate: () => false,
      saveAutoUpdate: () => undefined,
      fetchLatest: async () => ({ notModified: false, etag: 'etag-1', release }),
      fetchAsset: async (url) => (url.endsWith('.sig') ? Buffer.from(signature) : manifestBytes),
      downloadAsset: async (_url, destination) => {
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, packageBytes)
      },
      extractArchive: async (_archive, destination) => {
        await mkdir(join(destination, 'dist', 'cli'), { recursive: true })
        await mkdir(join(destination, 'node_modules'), { recursive: true })
        await writeFile(join(destination, 'dist', 'cli', 'index.js'), "console.log('0.2.0')\n")
        await writeFile(join(destination, 'package.json'), JSON.stringify({ version: '0.2.0' }))
      },
      loadKeys: () => [{ id: 'test', publicKeyPem: keys.publicKeyPem }],
      backupDatabase: async (destination) => writeFile(destination, 'database backup'),
      now: () => new Date('2026-10-23T12:00:00.000Z'),
    })

    const checked = await service.check(true)
    expect(checked.latest).toBe('0.2.0')
    expect(checked.updateAvailable).toBe(true)
    expect(checked.phase).toBe('idle')

    const applied = await service.apply()
    expect(applied.version).toBe('0.2.0')
    expect(service.getStatus().phase).toBe('applying')

    const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf-8')) as {
      version: string
      previous: { version: string }
      pending: { fromVersion: string }
    }
    expect(current.version).toBe('0.2.0')
    expect(current.previous.version).toBe('0.1.0')
    expect(current.pending.fromVersion).toBe('0.1.0')
    expect(await readFile(join(root, 'restart-requested.json'), 'utf-8')).toContain('0.2.0')
  })

  it('rejects a manifest signed by an untrusted key', async () => {
    const root = await makeRoot()
    const keys = generateReleaseKeyPair()
    const otherKeys = generateReleaseKeyPair()
    const manifest = {
      schemaVersion: 1,
      keyId: 'test',
      version: '0.2.0',
      tag: 'v0.2.0',
      commit: 'abcdef1',
      publishedAt: '2026-10-23T00:00:00.000Z',
      assets: [{ platform: 'win32', arch: 'x64', filename: 'a.zip', size: 1, sha256: 'a'.repeat(64) }],
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const signature = signManifest(manifestBytes, otherKeys.privateKeyPem)
    const release = {
      tagName: 'v0.2.0',
      name: '0.2.0',
      body: '',
      htmlUrl: '',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'manifest.json', size: manifestBytes.length, browserDownloadUrl: 'https://github.com/manifest.json' },
        {
          name: 'manifest.json.sig',
          size: signature.length,
          browserDownloadUrl: 'https://github.com/manifest.json.sig',
        },
        { name: 'a.zip', size: 1, browserDownloadUrl: 'https://github.com/a.zip' },
      ],
    }

    const service = new ReleaseUpdateService({
      root,
      currentVersion: '0.1.0',
      configDir: root,
      databasePath: join(root, 'sessions.db'),
      platform: 'win32',
      arch: 'x64',
      env: {},
      onRestart: () => undefined,
      getAutoUpdate: () => false,
      saveAutoUpdate: () => undefined,
      fetchLatest: async () => ({ notModified: false, etag: null, release }),
      fetchAsset: async (url) => (url.endsWith('.sig') ? Buffer.from(signature) : manifestBytes),
      loadKeys: () => [{ id: 'test', publicKeyPem: keys.publicKeyPem }],
      backupDatabase: async () => undefined,
    })

    const checked = await service.check(true)
    expect(checked.phase).toBe('error')
    expect(checked.error).toMatch(/signature/)
  })

  it('keeps the staged release when older versions are pruned at startup', async () => {
    const root = await makeRoot()
    const fixture = signedRelease('0.2.0')
    await mkdir(join(root, 'releases', '0.0.9'), { recursive: true })
    await mkdir(join(root, 'releases', '0.1.0'), { recursive: true })
    await mkdir(join(root, 'releases', fixture.version), { recursive: true })
    await writeFile(
      join(root, 'current.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: '0.1.0',
        dir: 'releases/0.1.0',
        previous: { version: '0.0.9', dir: 'releases/0.0.9' },
        updatedAt: '2026-10-23T00:00:00.000Z',
      }),
    )
    await writeFile(
      join(root, 'staged.json'),
      JSON.stringify({
        version: fixture.version,
        manifest: fixture.manifest,
        asset: fixture.manifest.assets[0],
        releaseUrl: fixture.release.htmlUrl,
        notes: fixture.release.body,
        stagedAt: '2026-10-23T00:00:00.000Z',
      }),
    )

    const service = new ReleaseUpdateService({
      root,
      currentVersion: '0.1.0',
      configDir: root,
      databasePath: join(root, 'sessions.db'),
      platform: 'win32',
      arch: 'x64',
      env: {},
      onRestart: () => undefined,
      getAutoUpdate: () => false,
      saveAutoUpdate: () => undefined,
    })

    await service.start()

    await expect(access(join(root, 'releases', fixture.version))).resolves.toBeUndefined()
    expect(service.getStatus().stagedVersion).toBe(fixture.version)
  })

  it('does not download a release that is already staged', async () => {
    const root = await makeRoot()
    const configDir = await makeRoot()
    const fixture = signedRelease('0.2.0')
    let downloads = 0

    const service = new ReleaseUpdateService({
      root,
      currentVersion: '0.1.0',
      configDir,
      databasePath: join(root, 'sessions.db'),
      platform: 'win32',
      arch: 'x64',
      env: {},
      onRestart: () => undefined,
      getAutoUpdate: () => false,
      saveAutoUpdate: () => undefined,
      fetchLatest: async () => ({ notModified: false, etag: 'etag-1', release: fixture.release }),
      fetchAsset: async (url) => (url.endsWith('.sig') ? Buffer.from(fixture.signature) : fixture.manifestBytes),
      downloadAsset: async (_url, destination) => {
        downloads += 1
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, fixture.packageBytes)
      },
      extractArchive: async (_archive, destination) => {
        await mkdir(join(destination, 'dist', 'cli'), { recursive: true })
        await mkdir(join(destination, 'node_modules'), { recursive: true })
        await writeFile(join(destination, 'dist', 'cli', 'index.js'), `console.log('${fixture.version}')\n`)
        await writeFile(join(destination, 'package.json'), JSON.stringify({ version: fixture.version }))
      },
      loadKeys: () => [{ id: 'test', publicKeyPem: fixture.keys.publicKeyPem }],
      backupDatabase: async () => undefined,
      now: () => new Date('2026-10-23T12:00:00.000Z'),
    })

    await service.check(true)
    await service.download()
    expect(downloads).toBe(1)
    expect(service.getStatus().phase).toBe('ready')

    await service.check(true)
    await service.download()
    expect(downloads).toBe(1)
  })
})
