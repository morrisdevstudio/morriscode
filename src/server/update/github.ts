import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const RELEASE_REPOSITORY = 'morrisdevstudio/morriscode-releases'
export const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`

export interface GithubReleaseAsset {
  name: string
  size: number
  browserDownloadUrl: string
}

export interface GithubRelease {
  tagName: string
  name: string
  body: string
  htmlUrl: string
  draft: boolean
  prerelease: boolean
  assets: GithubReleaseAsset[]
}

export interface LatestReleaseResult {
  notModified: boolean
  etag: string | null
  release: GithubRelease | null
}

export function parseGithubRelease(value: unknown): GithubRelease {
  if (!value || typeof value !== 'object') throw new Error('Invalid GitHub release payload')
  const record = value as Record<string, unknown>
  const assets = Array.isArray(record['assets']) ? record['assets'] : []
  return {
    tagName: String(record['tag_name'] ?? ''),
    name: String(record['name'] ?? ''),
    body: String(record['body'] ?? ''),
    htmlUrl: String(record['html_url'] ?? ''),
    draft: Boolean(record['draft']),
    prerelease: Boolean(record['prerelease']),
    assets: assets.map((asset) => {
      const item = asset as Record<string, unknown>
      return {
        name: String(item['name'] ?? ''),
        size: Number(item['size'] ?? 0),
        browserDownloadUrl: String(item['browser_download_url'] ?? ''),
      }
    }),
  }
}

export function findReleaseAsset(release: GithubRelease, name: string): GithubReleaseAsset | undefined {
  return release.assets.find((asset) => asset.name === name)
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

/** Only HTTPS URLs served by GitHub may be followed by the updater. */
export function isAllowedDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export async function fetchLatestRelease(etag?: string): Promise<LatestReleaseResult> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'MorrisCode-Updater',
    'x-github-api-version': '2022-11-28',
  }
  if (etag) headers['if-none-match'] = etag

  const response = await fetch(RELEASE_API_URL, { headers, signal: AbortSignal.timeout(15_000) })
  if (response.status === 304) {
    return { notModified: true, etag: response.headers.get('etag'), release: null }
  }
  if (response.status === 404) {
    throw new Error('No published release found in the public releases repository')
  }
  if (!response.ok) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}`)
  }
  return { notModified: false, etag: response.headers.get('etag'), release: parseGithubRelease(await response.json()) }
}

export async function fetchSmallAsset(url: string, maxBytes = 256 * 1024): Promise<Buffer> {
  if (!isAllowedDownloadUrl(url)) throw new Error('Release asset URL is not allowed')
  const response = await fetch(url, {
    headers: { 'user-agent': 'MorrisCode-Updater' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Release asset download failed with HTTP ${response.status}`)
  if (!isAllowedDownloadUrl(response.url)) throw new Error('Release asset redirected outside GitHub')
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new Error('Release metadata is unexpectedly large')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error('Release metadata is unexpectedly large')
  return buffer
}

export interface DownloadOptions {
  maxBytes: number
  onProgress?: (received: number, total: number) => void
}

export async function downloadAssetToFile(url: string, destination: string, options: DownloadOptions): Promise<void> {
  if (!isAllowedDownloadUrl(url)) throw new Error('Release asset URL is not allowed')
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  await rm(partial, { force: true })

  const response = await fetch(url, {
    headers: { 'user-agent': 'MorrisCode-Updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok) throw new Error(`Release asset download failed with HTTP ${response.status}`)
  if (!isAllowedDownloadUrl(response.url)) throw new Error('Release asset redirected outside GitHub')
  if (!response.body) throw new Error('Release asset response has no body')

  const total = Number(response.headers.get('content-length') ?? 0)
  if (total > options.maxBytes) throw new Error('Release asset exceeds the size limit')

  let received = 0
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > options.maxBytes) {
      source.destroy(new Error('Release asset exceeds the size limit'))
      return
    }
    options.onProgress?.(received, total)
  })

  try {
    await pipeline(source, createWriteStream(partial))
    await rename(partial, destination)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}
