import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  assetForPlatform,
  isNewerVersion,
  isStableVersion,
  parseReleaseManifest,
  versionFromTag,
  type ReleaseAsset,
  type ReleaseManifest,
} from '../../shared/update/manifest.js'
import { getDatabase } from '../db/index.js'
import { getSetting, setSetting, SETTINGS_KEYS } from '../db/settings.js'
import { logger } from '../utils/logger.js'
import { extractReleaseArchive } from './archive.js'
import {
  downloadAssetToFile,
  fetchLatestRelease,
  fetchSmallAsset,
  findReleaseAsset,
  type GithubRelease,
} from './github.js'
import {
  backupsDir,
  pathExists,
  readCurrentRelease,
  relativeVersionDir,
  stagingDir,
  updateStatusPath,
  versionDir,
  writeCurrentRelease,
  writeRestartRequest,
  type CurrentReleaseState,
} from './install.js'
import { trustedKeys, verifyManifestSignature } from './signing.js'
import type { TrustedReleaseKey } from './trusted-keys.js'

const execFileAsync = promisify(execFile)
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const MAX_BACKUPS = 3

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'applying' | 'error'

export interface ReleaseUpdateStatus {
  flavor: 'release'
  current: string
  latest: string | null
  phase: UpdatePhase
  updateAvailable: boolean
  autoUpdate: boolean
  received: number
  total: number
  error: string | null
  stagedVersion: string | null
  releaseUrl: string | null
  notes: string | null
  checkedAt: string | null
  lastApplied: string | null
}

interface StagedRelease {
  version: string
  manifest: ReleaseManifest
  asset: ReleaseAsset
  releaseUrl: string
  notes: string
  stagedAt: string
}

interface LastUpdateRecord {
  status: 'success' | 'failed'
  version: string
  message?: string
  at: string
}

export interface ReleaseUpdateServiceOptions {
  root: string
  currentVersion: string
  configDir: string
  databasePath: string
  onRestart: () => void
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  checkIntervalMs?: number
  fetchLatest?: typeof fetchLatestRelease
  fetchAsset?: typeof fetchSmallAsset
  downloadAsset?: typeof downloadAssetToFile
  extractArchive?: typeof extractReleaseArchive
  verifySignature?: typeof verifyManifestSignature
  loadKeys?: () => TrustedReleaseKey[]
  backupDatabase?: (destination: string) => Promise<void>
  getAutoUpdate?: () => boolean
  saveAutoUpdate?: (enabled: boolean) => void
  now?: () => Date
}

function timestampForDirectory(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export class ReleaseUpdateService {
  private readonly root: string
  private readonly currentVersion: string
  private readonly configDir: string
  private readonly databasePath: string
  private readonly onRestart: () => void
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly env: NodeJS.ProcessEnv
  private readonly checkIntervalMs: number
  private readonly fetchLatestImpl: typeof fetchLatestRelease
  private readonly fetchAssetImpl: typeof fetchSmallAsset
  private readonly downloadAssetImpl: typeof downloadAssetToFile
  private readonly extractImpl: typeof extractReleaseArchive
  private readonly verifyImpl: typeof verifyManifestSignature
  private readonly loadKeysImpl: () => TrustedReleaseKey[]
  private readonly backupDatabaseImpl: (destination: string) => Promise<void>
  private readonly getAutoUpdateImpl: () => boolean
  private readonly saveAutoUpdateImpl: (enabled: boolean) => void
  private readonly now: () => Date

  private latest: string | null = null
  private latestReleaseUrl: string | null = null
  private latestNotes: string | null = null
  private updateAvailable = false
  private phase: UpdatePhase = 'idle'
  private received = 0
  private total = 0
  private error: string | null = null
  private staged: StagedRelease | null = null
  private checkedAt: string | null = null
  private lastApplied: string | null = null
  private etag: string | null = null
  private candidate: { manifest: ReleaseManifest; asset: ReleaseAsset; release: GithubRelease } | null = null
  private checkPromise: Promise<ReleaseUpdateStatus> | null = null
  private downloadPromise: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ReleaseUpdateServiceOptions) {
    this.root = options.root
    this.currentVersion = options.currentVersion
    this.configDir = options.configDir
    this.databasePath = options.databasePath
    this.onRestart = options.onRestart
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.env = options.env ?? process.env
    this.checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS
    this.fetchLatestImpl = options.fetchLatest ?? fetchLatestRelease
    this.fetchAssetImpl = options.fetchAsset ?? fetchSmallAsset
    this.downloadAssetImpl = options.downloadAsset ?? downloadAssetToFile
    this.extractImpl = options.extractArchive ?? extractReleaseArchive
    this.verifyImpl = options.verifySignature ?? verifyManifestSignature
    this.loadKeysImpl = options.loadKeys ?? (() => trustedKeys())
    this.backupDatabaseImpl =
      options.backupDatabase ??
      (async (destination: string) => {
        await getDatabase().backup(destination)
      })
    this.getAutoUpdateImpl =
      options.getAutoUpdate ??
      (() => {
        const stored = getSetting(SETTINGS_KEYS.UPDATE_AUTO)
        if (stored !== null) return stored !== 'false'
        return this.env['MORRISCODE_AUTO_UPDATE_DEFAULT'] !== 'false'
      })
    this.saveAutoUpdateImpl =
      options.saveAutoUpdate ?? ((enabled) => setSetting(SETTINGS_KEYS.UPDATE_AUTO, enabled ? 'true' : 'false'))
    this.now = options.now ?? (() => new Date())
  }

  getAutoUpdate(): boolean {
    return this.getAutoUpdateImpl()
  }

  async setAutoUpdate(enabled: boolean): Promise<void> {
    this.saveAutoUpdateImpl(enabled)
    this.schedule(enabled)
  }

  getStatus(): ReleaseUpdateStatus {
    return {
      flavor: 'release',
      current: this.currentVersion,
      latest: this.latest,
      phase: this.phase,
      updateAvailable: this.updateAvailable,
      autoUpdate: this.getAutoUpdate(),
      received: this.received,
      total: this.total,
      error: this.error,
      stagedVersion: this.staged?.version ?? null,
      releaseUrl: this.latestReleaseUrl,
      notes: this.latestNotes,
      checkedAt: this.checkedAt,
      lastApplied: this.lastApplied,
    }
  }

  async start(): Promise<void> {
    await this.loadStagedRelease()
    await this.loadLastUpdate()
    await this.pruneOldReleases()
    await this.pruneOldBackups()
    this.schedule(this.getAutoUpdate())
    if (this.getAutoUpdate()) {
      void this.check(false).catch((error: unknown) =>
        logger.warn('[update] startup check failed', { error: String(error) }),
      )
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(enabled: boolean): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!enabled) return
    const jitter = Math.floor(Math.random() * 60_000)
    this.timer = setTimeout(() => {
      void this.check(false)
        .catch((error: unknown) => logger.warn('[update] background check failed', { error: String(error) }))
        .finally(() => this.schedule(this.getAutoUpdate()))
    }, this.checkIntervalMs + jitter)
    this.timer.unref?.()
  }

  async check(force: boolean): Promise<ReleaseUpdateStatus> {
    if (!force && !this.getAutoUpdate()) return this.getStatus()
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = this.runCheck()
    try {
      return await this.checkPromise
    } finally {
      this.checkPromise = null
    }
  }

  private async runCheck(): Promise<ReleaseUpdateStatus> {
    this.phase = 'checking'
    this.error = null
    try {
      const result = await this.fetchLatestImpl(this.etag ?? undefined)
      if (result.etag) this.etag = result.etag
      if (result.notModified) {
        this.phase = this.staged ? 'ready' : 'idle'
        return this.getStatus()
      }
      this.checkedAt = this.now().toISOString()
      const release = result.release
      if (!release || release.draft || release.prerelease) {
        this.phase = 'idle'
        return this.getStatus()
      }
      const version = versionFromTag(release.tagName)
      if (!isStableVersion(version)) {
        this.phase = 'idle'
        return this.getStatus()
      }
      this.latest = version
      this.latestReleaseUrl = release.htmlUrl
      this.latestNotes = release.body
      if (!isNewerVersion(version, this.currentVersion)) {
        this.updateAvailable = false
        this.phase = 'idle'
        return this.getStatus()
      }

      const manifestAsset = findReleaseAsset(release, 'manifest.json')
      const signatureAsset = findReleaseAsset(release, 'manifest.json.sig')
      if (!manifestAsset || !signatureAsset) {
        throw new Error('The release is missing its manifest or signature')
      }
      const [manifestBytes, signatureBytes] = await Promise.all([
        this.fetchAssetImpl(manifestAsset.browserDownloadUrl),
        this.fetchAssetImpl(signatureAsset.browserDownloadUrl),
      ])
      const manifest = parseReleaseManifest(manifestBytes.toString('utf-8'))
      if (manifest.version !== version) {
        throw new Error('The release tag and manifest version do not match')
      }
      if (!this.verifyImpl(manifestBytes, signatureBytes.toString('utf-8'), manifest.keyId, this.loadKeysImpl())) {
        throw new Error('The release manifest signature is not trusted')
      }
      const asset = assetForPlatform(manifest, this.platform, this.arch)
      if (!asset) {
        throw new Error(`No release package for ${this.platform}-${this.arch}`)
      }
      const releaseAsset = findReleaseAsset(release, asset.filename)
      if (!releaseAsset) {
        throw new Error('The release package is missing from GitHub')
      }

      this.updateAvailable = true
      this.candidate = { manifest, asset, release }
      if (this.autoUpdateEnabledOrForced()) {
        void this.download().catch(() => undefined)
      }
      this.phase = this.staged?.version === version ? 'ready' : this.downloadPromise ? 'downloading' : 'idle'
      return this.getStatus()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.phase = 'error'
      logger.warn('[update] release check failed', { error: this.error })
      return this.getStatus()
    }
  }

  private autoUpdateEnabledOrForced(): boolean {
    return this.getAutoUpdate()
  }

  async download(): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise
    this.downloadPromise = this.runDownload()
    try {
      await this.downloadPromise
    } finally {
      this.downloadPromise = null
    }
  }

  private async runDownload(): Promise<void> {
    if (!this.candidate) throw new Error('No release candidate to download')
    const { manifest, asset, release } = this.candidate
    const staging = stagingDir(this.root, manifest.version)
    this.phase = 'downloading'
    this.error = null
    this.received = 0
    this.total = asset.size
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      const archivePath = join(staging, asset.filename)
      const releaseAsset = findReleaseAsset(release, asset.filename)
      if (!releaseAsset) throw new Error('The release package is missing from GitHub')
      await this.downloadAssetImpl(releaseAsset.browserDownloadUrl, archivePath, {
        maxBytes: MAX_ARCHIVE_BYTES,
        onProgress: (received, total) => {
          this.received = received
          if (total > 0) this.total = total
        },
      })
      const downloaded = await stat(archivePath)
      if (downloaded.size !== asset.size) throw new Error('The downloaded package size is incorrect')
      if ((await hashFile(archivePath)) !== asset.sha256)
        throw new Error('The downloaded package checksum is incorrect')

      const payload = join(staging, 'payload')
      await this.extractImpl(archivePath, payload, this.platform)
      await this.validatePayload(payload, manifest.version)

      const destination = versionDir(this.root, manifest.version)
      await rm(destination, { recursive: true, force: true })
      await mkdir(dirname(destination), { recursive: true })
      await rename(payload, destination)

      const staged: StagedRelease = {
        version: manifest.version,
        manifest,
        asset,
        releaseUrl: release.htmlUrl,
        notes: release.body,
        stagedAt: this.now().toISOString(),
      }
      await writeFile(join(this.root, 'staged.json'), `${JSON.stringify(staged, null, 2)}\n`, 'utf-8')
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      this.staged = staged
      this.phase = 'ready'
      this.received = downloaded.size
      this.total = downloaded.size
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.phase = 'error'
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async validatePayload(payload: string, version: string): Promise<void> {
    const cliPath = join(payload, 'dist', 'cli', 'index.js')
    const packagePath = join(payload, 'package.json')
    if (!(await pathExists(cliPath))) throw new Error('The release package has no CLI entry point')
    if (!(await pathExists(join(payload, 'node_modules'))))
      throw new Error('The release package has no runtime dependencies')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf-8')) as { version?: string }
    if (packageJson.version !== version) throw new Error('The release package version is inconsistent')
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, '--version'], {
        cwd: payload,
        timeout: 30_000,
        windowsHide: true,
      })
      if (stdout.trim() !== version) throw new Error('The release package failed its version check')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`The release package failed its startup check: ${message}`)
    }
  }

  async apply(): Promise<{ version: string }> {
    if (this.staged) {
      this.candidate = { manifest: this.staged.manifest, asset: this.staged.asset, release: placeholders(this.staged) }
    }
    if (!this.candidate) throw new Error('No release is ready to install')
    if (!this.staged) await this.download()
    if (!this.staged) throw new Error('The release could not be prepared')
    const version = this.staged.version
    const releaseDir = versionDir(this.root, version)
    if (!(await pathExists(releaseDir))) throw new Error('The prepared release directory is missing')

    const current = await readCurrentRelease(this.root)
    const previous: { version: string; dir: string } = current
      ? { version: current.version, dir: current.dir }
      : { version: this.currentVersion, dir: this.currentReleaseDir() }
    const backupDir = join(backupsDir(this.root), timestampForDirectory(this.now()))
    await this.backup(backupDir)

    this.phase = 'applying'
    const state: CurrentReleaseState = {
      schemaVersion: 1,
      version,
      dir: relativeVersionDir(version),
      previous,
      pending: {
        fromVersion: previous.version,
        backupDir: relative(this.root, backupDir),
        startedAt: this.now().toISOString(),
        configDir: this.configDir,
        databasePath: this.databasePath,
      },
      updatedAt: this.now().toISOString(),
    }
    await writeCurrentRelease(this.root, state)
    await writeRestartRequest(this.root, version)
    return { version }
  }

  requestRestart(): void {
    this.onRestart()
  }

  async restart(): Promise<void> {
    await writeRestartRequest(this.root, this.currentVersion)
    this.requestRestart()
  }

  private currentReleaseDir(): string {
    const configured = this.env['MORRISCODE_RELEASE_DIR']
    if (configured) return configured
    return relativeVersionDir(this.currentVersion)
  }

  private async backup(destination: string): Promise<void> {
    await mkdir(destination, { recursive: true })
    const copies = ['config.json', 'auth.json', 'auth.key', 'certs']
    for (const name of copies) {
      const source = join(this.configDir, name)
      if (await pathExists(source)) {
        await cp(source, join(destination, name), { recursive: true, force: true })
      }
    }
    if (await pathExists(this.databasePath)) {
      await this.backupDatabaseImpl(join(destination, 'sessions.db'))
    }
    await writeFile(
      join(destination, 'backup.json'),
      `${JSON.stringify({ createdAt: this.now().toISOString(), version: this.currentVersion }, null, 2)}\n`,
      'utf-8',
    )
  }

  private async loadStagedRelease(): Promise<void> {
    try {
      const raw = await readFile(join(this.root, 'staged.json'), 'utf-8')
      const staged = JSON.parse(raw) as StagedRelease
      if (!isNewerVersion(staged.version, this.currentVersion)) return
      if (!(await pathExists(versionDir(this.root, staged.version)))) return
      this.staged = staged
      this.latest = staged.version
      this.latestReleaseUrl = staged.releaseUrl
      this.latestNotes = staged.notes
      this.updateAvailable = true
      this.phase = 'ready'
    } catch {
      // No prepared release yet.
    }
  }

  private async loadLastUpdate(): Promise<void> {
    try {
      const raw = await readFile(updateStatusPath(this.root), 'utf-8')
      const last = JSON.parse(raw) as LastUpdateRecord
      if (last.status === 'success') this.lastApplied = last.version
      else this.error = last.message ?? 'The previous update failed'
    } catch {
      // No previous update record.
    }
  }

  private async pruneOldReleases(): Promise<void> {
    try {
      const current = await readCurrentRelease(this.root)
      if (!current?.previous) return
      const keep = new Set([current?.version, current?.previous?.version].filter(Boolean) as string[])
      const releasesDir = join(this.root, 'releases')
      const entries = await readdir(releasesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (!/^\d+\.\d+\.\d+/.test(entry.name)) continue
        if (!keep.has(entry.name)) await rm(join(releasesDir, entry.name), { recursive: true, force: true })
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  private async pruneOldBackups(): Promise<void> {
    try {
      const entries = await readdir(backupsDir(this.root), { withFileTypes: true })
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      for (const name of directories.slice(0, Math.max(0, directories.length - MAX_BACKUPS))) {
        await rm(join(backupsDir(this.root), name), { recursive: true, force: true })
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

function placeholders(staged: StagedRelease): GithubRelease {
  return {
    tagName: `v${staged.version}`,
    name: staged.version,
    body: staged.notes,
    htmlUrl: staged.releaseUrl,
    draft: false,
    prerelease: false,
    assets: [],
  }
}
