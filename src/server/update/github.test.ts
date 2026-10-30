import { describe, expect, it } from 'vitest'
import { findReleaseAsset, isAllowedDownloadUrl, parseGithubRelease } from './github.js'

describe('GitHub release payload', () => {
  it('normalises the fields the updater needs', () => {
    const release = parseGithubRelease({
      tag_name: 'v0.2.0',
      name: '0.2.0',
      body: 'Notes',
      html_url: 'https://github.com/x/y/releases/tag/v0.2.0',
      draft: false,
      prerelease: false,
      assets: [{ name: 'manifest.json', size: 10, browser_download_url: 'https://github.com/a' }],
    })
    expect(release.tagName).toBe('v0.2.0')
    expect(findReleaseAsset(release, 'manifest.json')?.size).toBe(10)
    expect(findReleaseAsset(release, 'missing')).toBeUndefined()
  })
})

describe('release download URLs', () => {
  it('accepts HTTPS GitHub hosts only', () => {
    expect(isAllowedDownloadUrl('https://github.com/morrisdevstudio/x/releases/download/v1/a.zip')).toBe(true)
    expect(isAllowedDownloadUrl('https://objects.githubusercontent.com/a')).toBe(true)
    expect(isAllowedDownloadUrl('http://github.com/a')).toBe(false)
    expect(isAllowedDownloadUrl('https://evil.example.com/a')).toBe(false)
    expect(isAllowedDownloadUrl('not a url')).toBe(false)
  })
})
