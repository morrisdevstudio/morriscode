export interface TrustedReleaseKey {
  id: string
  publicKeyPem: string
}

/** Public keys allowed to sign release manifests. */
export const TRUSTED_RELEASE_KEYS: TrustedReleaseKey[] = [
  {
    id: 'release',
    publicKeyPem:
      '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEACREo28joElTSZbIZHvxGfI8w5TApN8qZFVUg0FCEcwQ=\n-----END PUBLIC KEY-----\n',
  },
]
