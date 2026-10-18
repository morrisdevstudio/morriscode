import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { generate } from 'selfsigned'
import { getGlobalConfigDir } from '../cli/paths.js'
import { getValidIPv4Addresses } from './utils/network.js'
import { logger } from './utils/logger.js'
import type { Config } from '../shared/types.js'

/** Days of validity for a generated certificate — the ceiling browsers apply to user-trusted certs. */
const CERTIFICATE_DAYS = 825
/** Regenerate when the certificate expires inside this window. */
const RENEWAL_WINDOW_DAYS = 30
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*'])

const CERT_FILE_NAME = 'server.crt'
const KEY_FILE_NAME = 'server.key'
const META_FILE_NAME = 'meta.json'

interface CertificateMeta {
  sans: string[]
  commonName: string
  createdAt: string
  expiresAt: string
}

export interface TlsMaterial {
  key: Buffer
  cert: Buffer
  /** Certificate in use: generated into the config directory, or the one named by the config. */
  certPath: string
  /** False when the certificate comes from server.httpsCert / server.httpsKey. */
  generated: boolean
}

/** The bits of the runtime/global config the certificate path depends on. */
export interface CertificateContext {
  server: { httpsCert?: string | undefined }
  globalConfigPath?: string | undefined
  mode?: 'development' | 'production' | 'test' | undefined
}

export function isHttpsEnabled(config: Config): boolean {
  return config.server.https === true
}

/** Directory holding the generated certificate. Follows the active config file, so dev and test stay isolated. */
export function certificateDirectory(config: CertificateContext): string {
  const base = config.globalConfigPath
    ? dirname(config.globalConfigPath)
    : getGlobalConfigDir(config.mode ?? 'production')
  return join(base, 'certs')
}

/** Where the certificate lives (or would live) — for display, without touching the disk. */
export function describeCertificate(config: CertificateContext): { certPath: string; generated: boolean } {
  if (config.server.httpsCert) {
    return { certPath: resolve(config.server.httpsCert), generated: false }
  }
  return { certPath: join(certificateDirectory(config), CERT_FILE_NAME), generated: true }
}

/**
 * Names the certificate must cover so peers reach it without a hostname mismatch:
 * loopback aliases, this machine's hostname, and every LAN address.
 */
export function buildCertificateSans(host?: string): string[] {
  const sans = new Set<string>(['localhost', '127.0.0.1', '::1'])

  const machineName = hostname()
  if (machineName) {
    sans.add(machineName)
    sans.add(`${machineName}.local`)
  }

  for (const ip of getValidIPv4Addresses()) {
    sans.add(ip)
  }

  // A literal bind address is what peers type in the URL bar, so it must be covered too.
  if (host && !WILDCARD_HOSTS.has(host) && isIP(host) !== 0) {
    sans.add(host)
  }

  return [...sans].sort()
}

function createCertificate(sans: string[], commonName: string): { cert: string; key: string } {
  const result = generate([{ name: 'commonName', value: commonName }], {
    days: CERTIFICATE_DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: false },
      { name: 'extKeyUsage', serverAuth: true, critical: false },
      {
        name: 'subjectAltName',
        // type 7 is an IP (v4 or v6), type 2 is a DNS name.
        altNames: sans.map((value) => (isIP(value) !== 0 ? { type: 7, ip: value } : { type: 2, value })),
      },
    ],
  })

  return { cert: result.cert, key: result.private }
}

function isCovered(existingSans: string[], requiredSans: string[]): boolean {
  const known = new Set(existingSans)
  return requiredSans.every((name) => known.has(name))
}

function daysUntil(isoDate: string): number {
  const time = Date.parse(isoDate)
  if (Number.isNaN(time)) return 0
  return (time - Date.now()) / 86_400_000
}

async function readCertificateMeta(metaPath: string): Promise<CertificateMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPath, 'utf-8')) as Partial<CertificateMeta>
    if (!Array.isArray(parsed.sans) || typeof parsed.expiresAt !== 'string') return null
    return {
      sans: parsed.sans,
      commonName: parsed.commonName ?? '',
      createdAt: parsed.createdAt ?? '',
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

/**
 * Reuse the certificate on disk when it still covers every required name and is
 * not about to expire. Reusing it keeps the trust a browser already granted —
 * regenerating forces every peer to accept the warning again.
 */
async function reuseGeneratedCertificate(dir: string, sans: string[]): Promise<TlsMaterial | null> {
  const certPath = join(dir, CERT_FILE_NAME)
  const meta = await readCertificateMeta(join(dir, META_FILE_NAME))
  if (!meta || !isCovered(meta.sans, sans) || daysUntil(meta.expiresAt) <= RENEWAL_WINDOW_DAYS) {
    return null
  }

  try {
    const [cert, key] = await Promise.all([readFile(certPath), readFile(join(dir, KEY_FILE_NAME))])
    return { cert, key, certPath, generated: true }
  } catch {
    return null
  }
}

/**
 * Resolve the TLS key pair for the server: null when HTTPS is off, the configured
 * PEM files when supplied, otherwise a generated self-signed certificate cached
 * in the config directory.
 */
export async function resolveTlsMaterial(config: Config): Promise<TlsMaterial | null> {
  if (!isHttpsEnabled(config)) return null

  const { httpsCert, httpsKey } = config.server
  if (httpsCert && httpsKey) {
    try {
      const [cert, key] = await Promise.all([readFile(httpsCert), readFile(httpsKey)])
      return { cert, key, certPath: resolve(httpsCert), generated: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`HTTPS is enabled but the certificate could not be read: ${message}`)
    }
  }
  if (httpsCert || httpsKey) {
    throw new Error(
      'HTTPS needs both server.httpsCert and server.httpsKey — set both, or neither to use a generated certificate',
    )
  }

  const sans = buildCertificateSans(config.server.host)
  const dir = certificateDirectory(config)

  const existing = await reuseGeneratedCertificate(dir, sans)
  if (existing) return existing

  const commonName = hostname() || 'localhost'
  const { cert, key } = createCertificate(sans, commonName)
  const createdAt = new Date()

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, KEY_FILE_NAME), key, { mode: 0o600 })
  await writeFile(join(dir, CERT_FILE_NAME), cert, { mode: 0o644 })
  await writeFile(
    join(dir, META_FILE_NAME),
    JSON.stringify(
      {
        sans,
        commonName,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + CERTIFICATE_DAYS * 86_400_000).toISOString(),
      } satisfies CertificateMeta,
      null,
      2,
    ),
    { mode: 0o600 },
  )

  logger.info('Generated a self-signed HTTPS certificate', { certPath: join(dir, CERT_FILE_NAME), sans })

  return { cert: Buffer.from(cert), key: Buffer.from(key), certPath: join(dir, CERT_FILE_NAME), generated: true }
}
