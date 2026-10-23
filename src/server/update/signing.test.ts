import { describe, expect, it } from 'vitest'
import { generateReleaseKeyPair, signManifest, verifyManifestSignature } from './signing.js'

describe('release manifest signature', () => {
  it('accepts a signature from a trusted key', () => {
    const keys = generateReleaseKeyPair()
    const manifest = Buffer.from('{"version":"0.2.0"}')
    const signature = signManifest(manifest, keys.privateKeyPem)
    expect(
      verifyManifestSignature(manifest, signature, 'test', [{ id: 'test', publicKeyPem: keys.publicKeyPem }]),
    ).toBe(true)
  })

  it('rejects a modified manifest, an unknown key and an empty signature', () => {
    const keys = generateReleaseKeyPair()
    const manifest = Buffer.from('{"version":"0.2.0"}')
    const signature = signManifest(manifest, keys.privateKeyPem)
    const trusted = [{ id: 'test', publicKeyPem: keys.publicKeyPem }]

    expect(verifyManifestSignature(Buffer.from('{"version":"9.9.9"}'), signature, 'test', trusted)).toBe(false)
    expect(verifyManifestSignature(manifest, signature, 'other', trusted)).toBe(false)
    expect(verifyManifestSignature(manifest, '', 'test', trusted)).toBe(false)
  })

  it('reports an unconfigured key ring instead of trusting anything', () => {
    expect(verifyManifestSignature(Buffer.from('{}'), 'c2ln', 'release', [])).toBe(false)
  })
})
