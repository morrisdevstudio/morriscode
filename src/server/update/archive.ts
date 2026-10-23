import { spawn } from 'node:child_process'
import { mkdir, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Reject absolute paths, Windows drive prefixes and parent traversal. */
export function isSafeArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/')
  if (normalized.length === 0 || normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  const parts = normalized.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/** Entries accepted by tar streams may start with ./, which is safe. */
export function normalizeArchiveEntry(entry: string): string {
  return entry.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function assertSafeArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    if (!isSafeArchiveEntry(normalizeArchiveEntry(entry))) {
      throw new Error(`Unsafe archive entry: ${entry}`)
    }
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; captureStdout?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    })
    let stdout = ''
    let stderr = ''
    if (options.captureStdout) {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })
    }
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))
    })
  })
}

async function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await runProcess(command, args, env ? { env } : {})
}

function runWithOutput(command: string, args: string[]): Promise<string> {
  return runProcess(command, args, { captureStdout: true })
}

const WINDOWS_EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = $env:MORRISCODE_ARCHIVE
$destination = $env:MORRISCODE_DEST
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName -replace '\\\\', '/'
    if ($name -eq '' -or $name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name -match '(^|/)\\.\\.(/|$)') {
      throw "Unsafe archive entry: $name"
    }
    $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixMode -eq 0xA000) {
      throw "Archive symlink rejected: $name"
    }
  }
} finally {
  $archive.Dispose()
}
Expand-Archive -LiteralPath $zipPath -DestinationPath $destination -Force
`

async function extractZip(archivePath: string, destination: string): Promise<void> {
  const encoded = Buffer.from(WINDOWS_EXTRACT_SCRIPT, 'utf16le').toString('base64')
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { ...process.env, MORRISCODE_ARCHIVE: archivePath, MORRISCODE_DEST: destination },
  )
}

async function extractTarGz(archivePath: string, destination: string): Promise<void> {
  const names = (await runWithOutput('tar', ['-tzf', archivePath]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  assertSafeArchiveEntries(names)

  const listing = (await runWithOutput('tar', ['-tvzf', archivePath])).split(/\r?\n/).filter(Boolean)
  for (const line of listing) {
    if (line.startsWith('h')) throw new Error(`Archive hard link rejected: ${line}`)
  }

  await run('tar', ['-xzf', archivePath, '-C', destination, '--no-same-owner', '--no-same-permissions'])
  await assertNoEscapingLinks(destination)
}

async function assertNoEscapingLinks(root: string): Promise<void> {
  const rootReal = await realpath(root)
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        const resolved = resolve(dirname(path), target)
        const realTarget = await realpath(resolved).catch(() => resolved)
        const relativeToRoot = relative(rootReal, realTarget)
        if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
          throw new Error(`Archive symlink escapes the destination: ${entry.name}`)
        }
        continue
      }
      if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(rootReal)
}

/** Extract a verified release archive into an empty destination directory. */
export async function extractReleaseArchive(
  archivePath: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  if (platform === 'win32') {
    if (!archivePath.toLowerCase().endsWith('.zip')) {
      throw new Error('Windows release archives must be .zip files')
    }
    await extractZip(archivePath, destination)
    return
  }
  if (!archivePath.toLowerCase().endsWith('.tar.gz')) {
    throw new Error('Linux release archives must be .tar.gz files')
  }
  await extractTarGz(archivePath, destination)
}
