import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type InstallFlavor = 'release' | 'npm' | 'development'

export interface ReleasePointer {
  version: string
  /** Path relative to the install root, e.g. releases/0.2.0. */
  dir: string
}

export interface PendingRelease {
  fromVersion: string
  backupDir: string
  startedAt: string
  configDir?: string
  databasePath?: string
}

export interface CurrentReleaseState {
  schemaVersion: 1
  version: string
  dir: string
  previous?: ReleasePointer
  pending?: PendingRelease
  updatedAt: string
}

export function detectInstallFlavor(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
): InstallFlavor {
  if (env['MORRISCODE_INSTALL_FLAVOR'] === 'release' || env['MORRISCODE_RELEASE_ROOT']) return 'release'
  if (env['NODE_ENV'] === 'development' || env['MORRISCODE_DEV'] === '1') return 'development'
  if (argv1 && /[\\/]releases[\\/][^\\/]+[\\/]dist[\\/]/.test(argv1)) return 'release'
  return 'npm'
}

/** Importer's best guess at the install root, used when the launcher did not set the env var. */
export function inferReleaseRoot(argv1: string | undefined = process.argv[1]): string | undefined {
  if (!argv1) return undefined
  const normalized = argv1.replace(/\\/g, '/')
  const marker = normalized.lastIndexOf('/releases/')
  if (marker === -1) return undefined
  return resolve(argv1.slice(0, marker).replace(/\\/g, '/'))
}

export function getReleaseRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['MORRISCODE_RELEASE_ROOT']
  if (configured) return resolve(configured)
  return inferReleaseRoot()
}

export function versionDir(root: string, version: string): string {
  return join(root, 'releases', version)
}

export function relativeVersionDir(version: string): string {
  return join('releases', version)
}

export function resolveVersionDir(root: string, dir: string): string {
  const candidate = isAbsolute(dir) ? dir : resolve(root, dir)
  const relativeToRoot = relative(root, candidate)
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error('Release directory escapes the install root')
  }
  return candidate
}

export function currentReleasePath(root: string): string {
  return join(root, 'current.json')
}

export function restartRequestPath(root: string): string {
  return join(root, 'restart-requested.json')
}

export function updateStatusPath(root: string): string {
  return join(root, 'last-update.json')
}

export function stagingDir(root: string, version: string): string {
  return join(root, 'releases', '.staging', version)
}

export function backupsDir(root: string): string {
  return join(root, 'update-backups')
}

export async function readCurrentRelease(root: string): Promise<CurrentReleaseState | null> {
  try {
    const raw = await readFile(currentReleasePath(root), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<CurrentReleaseState>
    if (parsed.schemaVersion !== 1 || typeof parsed.version !== 'string' || typeof parsed.dir !== 'string') {
      return null
    }
    return parsed as CurrentReleaseState
  } catch {
    return null
  }
}

/** Write through a temporary file so a crash never leaves half a pointer. */
export async function writeCurrentRelease(root: string, state: CurrentReleaseState): Promise<void> {
  const target = currentReleasePath(root)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  try {
    await rename(temporary, target)
  } catch {
    await rm(target, { force: true })
    await rename(temporary, target)
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export type RestartRequest = {
  schemaVersion: 1
  targetVersion: string
  requestedAt: string
}

export async function writeRestartRequest(root: string, targetVersion: string): Promise<void> {
  const path = restartRequestPath(root)
  await mkdir(dirname(path), { recursive: true })
  const request: RestartRequest = {
    schemaVersion: 1,
    targetVersion,
    requestedAt: new Date().toISOString(),
  }
  await writeFile(path, `${JSON.stringify(request, null, 2)}\n`, 'utf-8')
}
