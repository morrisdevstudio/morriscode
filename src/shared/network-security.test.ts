import { describe, expect, it } from 'vitest'
import { isLoopbackHost, networkAccessError } from './network-security.js'

describe('network access safety', () => {
  it.each(['127.0.0.1', '127.22.3.4', '::1', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1'])(
    'allows loopback HTTP without authentication: %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true)
      expect(networkAccessError(host, false, false)).toBeNull()
    },
  )

  it.each(['0.0.0.0', '::', '192.168.1.5', 'my-computer', '127.evil.test', 'localhost.evil.test'])(
    'requires HTTPS and authentication for %s',
    (host) => {
      expect(networkAccessError(host, false, true)?.en).toContain('HTTPS')
      expect(networkAccessError(host, true, false)?.en).toContain('password')
      expect(networkAccessError(host, true, false)?.fr).toContain('mot de passe')
      expect(networkAccessError(host, true, true)).toBeNull()
    },
  )
})
