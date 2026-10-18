import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { generate } from 'selfsigned'
import type { Config } from '../shared/types.js'

const TEST_DIR = join(tmpdir(), `morriscode-tls-test-${Date.now()}`)

vi.mock('../cli/paths.js', () => ({
  getGlobalConfigDir: (mode: string) => join(TEST_DIR, mode),
}))

import { buildCertificateSans, certificateDirectory, describeCertificate, resolveTlsMaterial } from './tls.js'
import { getValidIPv4Addresses } from './utils/network.js'

function makeConfig(server: Partial<Config['server']> = {}): Config {
  return {
    llm: { baseUrl: 'http://localhost:8000/v1', model: '', timeout: 1000, idleTimeout: 1000, backend: 'unknown' },
    context: { maxTokens: 2000, compactionThreshold: 0.85, compactionTarget: 0.6 },
    agent: { maxIterations: 1, maxConsecutiveFailures: 1, toolTimeout: 1000 },
    server: { port: 10369, host: '127.0.0.1', ...server },
    database: { path: ':memory:' },
    mode: 'test',
    workdir: process.cwd(),
  }
}

describe('buildCertificateSans', () => {
  it('covers loopback aliases, the machine hostname and every LAN address', () => {
    const sans = buildCertificateSans('0.0.0.0')
    expect(sans).toContain('localhost')
    expect(sans).toContain('127.0.0.1')
    for (const ip of getValidIPv4Addresses()) {
      expect(sans).toContain(ip)
    }
    expect(sans).not.toContain('0.0.0.0')
  })

  it('adds a literal bind address, which is what peers type in the URL bar', () => {
    expect(buildCertificateSans('192.168.44.7')).toContain('192.168.44.7')
  })
})

describe('certificateDirectory', () => {
  it('follows the active config file so dev, prod and test stay isolated', () => {
    expect(certificateDirectory({ server: {}, globalConfigPath: join('tmp', 'prod', 'config.json') })).toBe(
      join('tmp', 'prod', 'certs'),
    )
  })

  it('falls back to the config directory of the mode', () => {
    expect(certificateDirectory({ server: {}, mode: 'test' })).toBe(join(TEST_DIR, 'test', 'certs'))
  })
})

describe('describeCertificate', () => {
  it('reports a provided certificate when the config names one', () => {
    const info = describeCertificate({ server: { httpsCert: '/etc/certs/morriscode.pem' }, mode: 'test' })
    expect(info.generated).toBe(false)
    expect(info.certPath).toContain('morriscode.pem')
  })

  it('points at the generated certificate otherwise', () => {
    const info = describeCertificate({ server: {}, mode: 'test' })
    expect(info.generated).toBe(true)
    expect(info.certPath).toBe(join(TEST_DIR, 'test', 'certs', 'server.crt'))
  })
})

describe('resolveTlsMaterial', () => {
  beforeEach(async () => {
    await mkdir(join(TEST_DIR, 'test'), { recursive: true })
  })

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  it('returns null when HTTPS is off', async () => {
    expect(await resolveTlsMaterial(makeConfig({ https: false }))).toBeNull()
    expect(await resolveTlsMaterial(makeConfig())).toBeNull()
  })

  it('generates a certificate covering the LAN addresses and reuses it afterwards', async () => {
    const first = await resolveTlsMaterial(makeConfig({ https: true, host: '0.0.0.0' }))
    expect(first).not.toBeNull()
    expect(first!.generated).toBe(true)

    const certificate = new X509Certificate(first!.cert)
    expect(certificate.subjectAltName).toContain('127.0.0.1')
    // Loopback v6 is an address, not a hostname.
    expect(certificate.subjectAltName).not.toContain('DNS:::1')
    for (const ip of getValidIPv4Addresses()) {
      expect(certificate.subjectAltName).toContain(ip)
    }

    const meta = JSON.parse(await readFile(join(TEST_DIR, 'test', 'certs', 'meta.json'), 'utf-8'))
    expect(meta.sans).toEqual(expect.arrayContaining(buildCertificateSans('0.0.0.0')))

    const second = await resolveTlsMaterial(makeConfig({ https: true, host: '0.0.0.0' }))
    expect(second!.cert.equals(first!.cert)).toBe(true)
    expect(second!.key.equals(first!.key)).toBe(true)
  })

  it('regenerates when the private key is gone, rather than serving a broken pair', async () => {
    const first = await resolveTlsMaterial(makeConfig({ https: true }))
    await rm(join(TEST_DIR, 'test', 'certs', 'server.key'))

    const second = await resolveTlsMaterial(makeConfig({ https: true }))
    expect(second!.cert.equals(first!.cert)).toBe(false)
  })

  it('regenerates when the certificate no longer covers a needed address', async () => {
    const first = await resolveTlsMaterial(makeConfig({ https: true, host: '192.168.44.7' }))
    // Drop the meta so the stored SAN list no longer matches what is required.
    await rm(join(TEST_DIR, 'test', 'certs', 'meta.json'))

    const second = await resolveTlsMaterial(makeConfig({ https: true, host: '192.168.44.7' }))
    expect(second!.cert.equals(first!.cert)).toBe(false)
  })

  it('reads a provided certificate and key instead of generating one', async () => {
    const pair = generate([{ name: 'commonName', value: 'localhost' }], { days: 2, keySize: 2048, algorithm: 'sha256' })
    const certPath = join(TEST_DIR, 'provided.crt')
    const keyPath = join(TEST_DIR, 'provided.key')
    await writeFile(certPath, pair.cert)
    await writeFile(keyPath, pair.private)

    const material = await resolveTlsMaterial(makeConfig({ https: true, httpsCert: certPath, httpsKey: keyPath }))
    expect(material!.generated).toBe(false)
    expect(material!.cert.toString()).toBe(pair.cert)
    expect(material!.key.toString()).toBe(pair.private)
  })

  it('refuses a half-configured certificate instead of silently generating one', async () => {
    await expect(resolveTlsMaterial(makeConfig({ https: true, httpsCert: 'only-cert.pem' }))).rejects.toThrow(
      /httpsCert and server.httpsKey/,
    )
  })

  it('reports an unreadable provided certificate', async () => {
    await expect(
      resolveTlsMaterial(makeConfig({ https: true, httpsCert: '/nope/missing.crt', httpsKey: '/nope/missing.key' })),
    ).rejects.toThrow(/could not be read/)
  })
})
