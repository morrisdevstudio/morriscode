import { createServer } from 'node:net'
import { MorrisCodeError } from '../server/utils/errors.js'

/** Probe all IPv4 interfaces so localhost and LAN launches choose the same free port. */
export async function findDevPort(preferred: number): Promise<number> {
  const last = Math.min(preferred + 100, 65535)
  for (let port = preferred; port <= last; port++) {
    const available = await new Promise<boolean>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
        else reject(error)
      })
      probe.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
        probe.close((error) => (error ? reject(error) : resolve(true)))
      })
    })
    if (available) return port
  }
  throw new MorrisCodeError(`No available development port in range ${preferred}-${last}`, 'NO_AVAILABLE_PORT')
}
