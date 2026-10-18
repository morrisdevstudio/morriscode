// HTTPS E2E Tests
//
// The server binds one listener: with TLS on, the same port serves the UI, the API
// and the application WebSocket over https/wss, and plain HTTP no longer answers.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpsRequest } from 'node:https'
import { generate } from 'selfsigned'
import { WebSocket } from 'ws'
import { createTestServer, type TestServerHandle } from './utils/index.js'
import * as auth from '../src/server/auth.js'
import { setRuntimeConfig } from '../src/server/runtime-config.js'

interface HttpsResponse {
  status: number
  body: string
}

// The certificate is self-signed, so the probe accepts it explicitly.
function httpsGet(url: string): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { rejectUnauthorized: false }, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += String(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function httpsJson(method: string, url: string, payload: unknown): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = httpsRequest(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let received = ''
        res.on('data', (chunk) => {
          received += String(chunk)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: received }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('HTTPS server', () => {
  let server: TestServerHandle
  let certDir: string

  beforeAll(async () => {
    certDir = await mkdtemp(join(tmpdir(), 'morriscode-https-'))
    const pair = generate([{ name: 'commonName', value: 'localhost' }], {
      days: 2,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    })
    const httpsCert = join(certDir, 'test.crt')
    const httpsKey = join(certDir, 'test.key')
    await writeFile(httpsCert, pair.cert)
    await writeFile(httpsKey, pair.private)

    server = await createTestServer({ https: true, httpsCert, httpsKey })
  })

  afterAll(async () => {
    await server.close()
    await rm(certDir, { recursive: true, force: true })
  })

  it('serves the REST API over TLS', async () => {
    const res = await httpsGet(server.url + '/api/health')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' })
  })

  it('reports the HTTPS origin and its LAN URLs', async () => {
    const res = await httpsGet(server.url + '/api/config')
    const { serverNetwork } = JSON.parse(res.body) as {
      serverNetwork: { https: boolean; urls: string[]; certificatePath: string | null }
    }
    expect(serverNetwork.https).toBe(true)
    expect(serverNetwork.certificatePath).toBe(join(certDir, 'test.crt'))
    for (const url of serverNetwork.urls) {
      expect(url.startsWith('https://')).toBe(true)
    }
  })

  it('refuses a plain HTTP request on the TLS port', async () => {
    await expect(fetch('http://127.0.0.1:' + server.port + '/api/health')).rejects.toThrow()
  })

  it('rejects a malformed network settings payload', async () => {
    const res = await httpsJson('PUT', server.url + '/api/config/network', { https: 'yes' })
    expect(res.status).toBe(400)
  })

  it.each([
    { host: '0.0.0.0', https: false },
    { host: '0.0.0.0', https: true },
    { host: '192.168.1.8' },
    { host: '::', https: true },
  ])('rejects unsafe network settings without changing the config: %j', async (payload) => {
    const before = await readFile(server.globalConfigPath, 'utf-8').catch(() => null)
    const res = await httpsJson('PUT', server.url + '/api/config/network', payload)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/HTTPS|password|mot de passe/)
    expect(await readFile(server.globalConfigPath, 'utf-8').catch(() => null)).toBe(before)
  })

  it('persists safe loopback settings to the config and asks for a restart', async () => {
    const res = await httpsJson('PUT', server.url + '/api/config/network', { host: '127.0.0.1', https: true })
    expect(res.status).toBe(200)

    const body = JSON.parse(res.body) as {
      restartRequired: boolean
      serverNetwork: { host: string; https: boolean; urls: string[] }
    }
    expect(body.restartRequired).toBe(true)
    expect(body.serverNetwork.host).toBe('127.0.0.1')
    expect(body.serverNetwork.https).toBe(true)
    expect(body.serverNetwork.urls.every((url) => url.startsWith('https://'))).toBe(true)

    const saved = JSON.parse(await readFile(server.globalConfigPath, 'utf-8')) as {
      server: { host: string; https: boolean }
    }
    expect(saved.server.host).toBe('127.0.0.1')
    expect(saved.server.https).toBe(true)
  })

  it('implies HTTPS for network settings when working authentication exists', async () => {
    const spy = vi.spyOn(auth, 'hasEffectiveNetworkAuth').mockResolvedValue(true)
    try {
      const res = await httpsJson('PUT', server.url + '/api/config/network', { host: '0.0.0.0' })
      expect(res.status).toBe(200)
      const saved = JSON.parse(await readFile(server.globalConfigPath, 'utf-8'))
      expect(saved.server).toMatchObject({ host: '0.0.0.0', https: true })
      const refused = await httpsJson('PUT', server.url + '/api/config/network', { https: false })
      expect(refused.status).toBe(400)
      expect(JSON.parse(await readFile(server.globalConfigPath, 'utf-8')).server.https).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('accepts the application WebSocket over wss', async () => {
    const ws = new WebSocket(server.wsUrl, { rejectUnauthorized: false })

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timeout'))
      }, 5000)

      ws.on('open', () => {
        clearTimeout(timeout)
        ws.close()
        resolve()
      })
      ws.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  })

  it.each([
    { host: '0.0.0.0', https: false },
    { host: '0.0.0.0', https: true },
    { host: '::', https: true },
    { host: '192.168.1.8', https: false },
  ])('rejects unsafe startup before initializing a server: %j', async (network) => {
    const { createServerHandle } = await import('../src/server/index.js')
    try {
      await expect(
        createServerHandle({
          ...server.ctx.config,
          server: { ...server.ctx.config.server, ...network },
        }),
      ).rejects.toThrow(/HTTPS|password|mot de passe/)
    } finally {
      setRuntimeConfig(server.ctx.config)
    }
  })
})
