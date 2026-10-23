export interface TrustedReleaseKey {
  id: string
  publicKeyPem: string
}

/**
 * Public keys allowed to sign release manifests. The private key never lives in
 * this repository; add the public half produced by scripts/setup-release-signing.mjs.
 */
export const TRUSTED_RELEASE_KEYS: TrustedReleaseKey[] = []
