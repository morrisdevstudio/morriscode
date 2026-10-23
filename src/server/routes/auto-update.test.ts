import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import express from 'express'
import { createAutoUpdateRoutes, resetUpdateInProgress, resetVersionCache } from './auto-update.js'

function makeMockChild(opts: { stdout?: string; stderr?: string; exitCode?: number }) {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter() as any
  child.stderr = new EventEmitter() as any
  child.kill = vi.fn()
  child.unref = vi.fn()
  // Defer emissions so the handler can attach listeners
  process.nextTick(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout))
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr))
    child.emit('close', opts.exitCode ?? 0)
  })
  return child
}

const mockSpawn = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

describe('Auto Update Routes', () => {
  let app: express.Express
  let server: ReturnType<typeof app.listen>
  let baseUrl: string

  beforeEach(async () => {
    mockSpawn.mockReset()
    // Default: npm view returns a version, morriscode update succeeds
    mockSpawn.mockImplementation((cmd: unknown, args: unknown) => {
      // auto-update.ts spawns npm as a shell string on win32 (npm.cmd there,
      // CVE-2024-27980) and as argv elsewhere — match both.
      if (cmd === 'npm view morriscode version' || (cmd === 'npm' && Array.isArray(args) && args[0] === 'view')) {
        return makeMockChild({ stdout: '1.2.3\n' })
      }
      // git fetch returns nothing
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'fetch') {
        return makeMockChild({ stdout: '' })
      }
      // git describe returns just the tag name
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'describe') {
        return makeMockChild({ stdout: '1.2.3\n' })
      }
      return makeMockChild({ stdout: 'Updated: 1.2.3\n' })
    })

    app = express()
    app.use(express.json())
    app.use('/api/auto-update', createAutoUpdateRoutes())

    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterEach(() => {
    server?.close()
    resetUpdateInProgress()
    resetVersionCache()
  })

  describe('GET /api/auto-update/check', () => {
    it('returns current version and latest', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update/check`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        current: string
        latest: string
        isUpdateAvailable: boolean
        isService: boolean
      }
      expect(typeof body.current).toBe('string')
      expect(typeof body.latest).toBe('string')
      expect(typeof body.isUpdateAvailable).toBe('boolean')
      expect(typeof body.isService).toBe('boolean')
    })

    it('returns isUpdateAvailable false when current matches latest', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update/check`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { current: string; latest: string; isUpdateAvailable: boolean }
      expect(body.isUpdateAvailable).toBe(body.current !== body.latest)
    })

    it('returns cached result on subsequent requests', async () => {
      // First request
      const res1 = await fetch(`${baseUrl}/api/auto-update/check`)
      expect(res1.status).toBe(200)
      const body1 = (await res1.json()) as { latest: string }
      const latestVersion = body1.latest

      // Reset mock to ensure second call uses cache (doesn't call spawn again)
      mockSpawn.mockClear()

      // Second request should use cache
      const res2 = await fetch(`${baseUrl}/api/auto-update/check`)
      expect(res2.status).toBe(200)
      const body2 = (await res2.json()) as { latest: string }
      expect(body2.latest).toBe(latestVersion)
      // Should not have called spawn again (cache hit)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('bypasses cache with force=true parameter', async () => {
      // First request to populate cache
      await fetch(`${baseUrl}/api/auto-update/check`)
      mockSpawn.mockClear()

      // Force refresh should call git fetch again
      const res = await fetch(`${baseUrl}/api/auto-update/check?force=true`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { latest: string }
      expect(body.latest).toBe('1.2.3')
      // Should have called spawn for git fetch
      expect(mockSpawn).toHaveBeenCalled()
    })
  })

  describe('POST /api/auto-update (no auth required)', () => {
    it('returns a response with success or error and isService', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; isService: boolean; version?: string; error?: string }
      expect(typeof body.success).toBe('boolean')
      expect(typeof body.isService).toBe('boolean')
      if (body.success) {
        expect(typeof body.version).toBe('string')
      } else {
        expect(typeof body.error).toBe('string')
      }
    })

    it('parses the version from English CLI output', async () => {
      mockSpawn.mockImplementation((cmd: unknown, args: unknown) => {
        if (cmd === 'npm view morriscode version' || (cmd === 'npm' && Array.isArray(args) && args[0] === 'view')) {
          return makeMockChild({ stdout: '1.2.3\n' })
        }
        return makeMockChild({ stdout: 'Updated: 1.2.3\n' })
      })
      const res = await fetch(`${baseUrl}/api/auto-update`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; version?: string }
      expect(body.success).toBe(true)
      expect(body.version).toBe('1.2.3')
    })

    it('parses the version from French CLI output', async () => {
      mockSpawn.mockImplementation((cmd: unknown, args: unknown) => {
        if (cmd === 'npm view morriscode version' || (cmd === 'npm' && Array.isArray(args) && args[0] === 'view')) {
          return makeMockChild({ stdout: '1.2.3\n' })
        }
        return makeMockChild({ stdout: 'Mis à jour : 1.2.3\n' })
      })
      const res = await fetch(`${baseUrl}/api/auto-update`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; version?: string }
      expect(body.success).toBe(true)
      expect(body.version).toBe('1.2.3')
    })
  })
})

describe('Auto Update Routes (auth required)', () => {
  let app: express.Express
  let server: ReturnType<typeof app.listen>
  let baseUrl: string
  let validToken: string

  beforeEach(async () => {
    validToken = 'Bearer valid-token-123'
    app = express()
    app.use(express.json())
    app.use(
      '/api/auto-update',
      createAutoUpdateRoutes({
        requireAuth: (req) => {
          const authHeader = req.headers['authorization']
          if (!authHeader || authHeader !== validToken) {
            return Promise.resolve(false)
          }
          return Promise.resolve(true)
        },
      }),
    )

    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterEach(() => {
    server?.close()
    resetUpdateInProgress()
  })

  describe('POST /api/auto-update', () => {
    it('rejects request without authorization header', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update`, { method: 'POST' })
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Unauthorized')
    })

    it('rejects request with invalid token', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      })
      expect(res.status).toBe(401)
    })

    it('accepts request with valid token', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update`, {
        method: 'POST',
        headers: { Authorization: validToken },
      })
      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/auto-update/restart', () => {
    it('rejects request without authorization header', async () => {
      const res = await fetch(`${baseUrl}/api/auto-update/restart`, { method: 'POST' })
      expect(res.status).toBe(401)
    })
  })
})

describe('Auto Update Routes (release installs)', () => {
  it('exposes the release status and applies the prepared version', async () => {
    let applied = false
    let restarted = false
    let autoUpdate = true
    const status = {
      flavor: 'release',
      current: '0.1.0',
      latest: '0.2.0',
      phase: 'ready',
      updateAvailable: true,
      autoUpdate: true,
      received: 10,
      total: 10,
      error: null,
      stagedVersion: '0.2.0',
      releaseUrl: 'https://github.com/example/releases/tag/v0.2.0',
      notes: 'Notes',
      checkedAt: '2026-10-23T00:00:00.000Z',
      lastApplied: null,
    }
    const app = express()
    app.use(express.json())
    app.use(
      '/api/auto-update',
      createAutoUpdateRoutes({
        releaseService: {
          check: async () => status,
          getStatus: () => ({ ...status, autoUpdate }),
          apply: async () => {
            applied = true
            return { version: '0.2.0' }
          },
          requestRestart: () => {
            restarted = true
          },
          setAutoUpdate: async (enabled: boolean) => {
            autoUpdate = enabled
          },
          restart: async () => {
            restarted = true
          },
        } as any,
      }),
    )
    const server = app.listen(0)
    const url = `http://localhost:${(server.address() as any).port}`
    try {
      const checked = (await (await fetch(`${url}/api/auto-update/check`)).json()) as {
        flavor: string
        isUpdateAvailable: boolean
        stagedVersion: string
      }
      expect(checked.flavor).toBe('release')
      expect(checked.isUpdateAvailable).toBe(true)
      expect(checked.stagedVersion).toBe('0.2.0')

      const statusResponse = (await (await fetch(`${url}/api/auto-update/status`)).json()) as { phase: string }
      expect(statusResponse.phase).toBe('ready')

      const settings = await fetch(`${url}/api/auto-update/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoUpdate: false }),
      })
      expect(settings.status).toBe(200)
      expect(((await settings.json()) as { autoUpdate: boolean }).autoUpdate).toBe(false)

      const appliedResponse = await fetch(`${url}/api/auto-update`, { method: 'POST' })
      expect(appliedResponse.status).toBe(200)
      expect(((await appliedResponse.json()) as { success: boolean }).success).toBe(true)
      expect(applied).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(restarted).toBe(true)
    } finally {
      server.close()
    }
  })
})
