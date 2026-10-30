import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { TRUSTED_RELEASE_KEYS, type TrustedReleaseKey } from './trusted-keys.js'

/** Only keys compiled into the application are trusted. */
export function trustedKeys(): TrustedReleaseKey[] {
  return TRUSTED_RELEASE_KEYS
}

/** Verify a base64 Ed25519 signature over the exact manifest bytes. */
export function verifyManifestSignature(
  manifest: Buffer,
  signatureBase64: string,
  keyId: string,
  keys: TrustedReleaseKey[] = trustedKeys(),
): boolean {
  const trusted = keys.find((key) => key.id === keyId)
  if (!trusted) return false
  try {
    const signature = Buffer.from(signatureBase64.trim(), 'base64')
    if (signature.length === 0) return false
    return verify(null, manifest, createPublicKey(trusted.publicKeyPem), signature)
  } catch {
    return false
  }
}

export function generateReleaseKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

export function signManifest(manifest: Buffer, privateKeyPem: string): string {
  return sign(null, manifest, privateKeyPem).toString('base64')
}
