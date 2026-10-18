import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { findDevPort } from './dev-port.js'

describe('development port selection', () => {
  it('skips a port already occupied by another application', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve))
    try {
      const address = occupied.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const selected = await findDevPort(address.port)
      expect(selected).toBeGreaterThan(address.port)
      expect(await findDevPort(selected)).toBe(selected)
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
