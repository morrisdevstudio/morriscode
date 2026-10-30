import { describe, expect, it } from 'vitest'
import {
  assetForPlatform,
  compareVersions,
  isNewerVersion,
  isStableVersion,
  parseReleaseManifest,
  parseVersion,
  versionFromTag,
} from './manifest.js'

const manifestText = JSON.stringify({
  schemaVersion: 1,
  keyId: 'release-2026',
  version: '0.2.0',
  tag: 'v0.2.0',
  commit: '0123456',
  publishedAt: '2026-10-24T00:00:00.000Z',
  assets: [
    {
      platform: 'win32',
      arch: 'x64',
      filename: 'morriscode-0.2.0-win32-x64.zip',
      size: 42,
      sha256: 'a'.repeat(64),
    },
    {
      platform: 'linux',
      arch: 'x64',
      filename: 'morriscode-0.2.0-linux-x64.tar.gz',
      size: 43,
      sha256: 'b'.repeat(64),
    },
  ],
})

describe('release manifest', () => {
  it('parses a complete manifest and selects the platform asset', () => {
    const manifest = parseReleaseManifest(manifestText)
    expect(manifest.version).toBe('0.2.0')
    expect(assetForPlatform(manifest, 'win32', 'x64')?.filename).toContain('win32-x64')
    expect(assetForPlatform(manifest, 'linux', 'x64')?.filename).toContain('linux-x64')
    expect(assetForPlatform(manifest, 'win32', 'arm64')).toBeUndefined()
  })

  it('rejects an invalid digest', () => {
    const invalid = JSON.parse(manifestText) as { assets: Array<{ sha256: string }> }
    invalid.assets[0]!.sha256 = 'nope'
    expect(() => parseReleaseManifest(JSON.stringify(invalid))).toThrow()
  })
})

describe('version comparison', () => {
  it('compares numeric segments', () => {
    expect(parseVersion('v0.2.10')).toMatchObject({ major: 0, minor: 2, patch: 10 })
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
  })

  it('sorts prereleases before the matching stable version', () => {
    expect(compareVersions('0.2.0-dev', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBe(1)
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.10')).toBe(-1)
  })

  it('only treats a newer version as an update', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
    expect(isStableVersion('0.2.0')).toBe(true)
    expect(isStableVersion('0.2.0-beta.1')).toBe(false)
    expect(versionFromTag('v0.2.0')).toBe('0.2.0')
  })
})
