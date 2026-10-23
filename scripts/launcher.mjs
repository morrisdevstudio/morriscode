#!/usr/bin/env node
/**
 * Stable launcher for release installs.
 *
 * It is copied outside the versioned releases and never replaced by an update.
 * It starts the version referenced by current.json, verifies /api/health and
 * restores the previous release (and its database/config snapshot) when a new
 * version cannot start.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

const HEALTH_TIMEOUT_MS = 90_000
const LOG_LIMIT_BYTES = 5 * 1024 * 1024

export function isWithinRoot(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const relativePath = relative(resolvedRoot, resolvedCandidate)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return fallback
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  try {
    await rename(temporary, path)
  } catch {
    await rm(path, { force: true })
    await rename(temporary, path)
  }
}

async function rotateLog(path) {
  try {
    const info = await stat(path)
    if (info.size > LOG_LIMIT_BYTES) await rename(path, `${path}.1`)
  } catch {
    // No log yet.
  }
}

async function log(root, message) {
  const logsDir = join(root, 'logs')
  await mkdir(logsDir, { recursive: true })
  const path = join(logsDir, 'launcher.log')
  await rotateLog(path)
  await appendFile(path, `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
}

function healthRequest(port, scheme) {
  return new Promise((resolvePromise) => {
    const client = scheme === 'https' ? https : http
    const req = client.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 2_000, rejectUnauthorized: false },
      (response) => {
        let body = ''
        response.setEncoding('utf-8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            resolvePromise(null)
            return
          }
          try {
            resolvePromise(JSON.parse(body).version ?? null)
          } catch {
            resolvePromise(null)
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolvePromise(null)
    })
    req.on('error', () => resolvePromise(null))
  })
}

async function waitUntilHealthy(port, scheme, timeoutMs, expectedVersion) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const version = await healthRequest(port, scheme)
    if (version && (!expectedVersion || version === expectedVersion)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  return false
}

function startChild(root, state, config) {
  const releaseDir = resolve(root, state.dir)
  if (!isWithinRoot(root, releaseDir)) throw new Error(`Release directory escapes the install root: ${state.dir}`)
  const cli = join(releaseDir, 'dist', 'cli', 'index.js')
  const logPath = join(root, 'logs', 'server.log')
  const output = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(process.execPath, [cli, ...(config.args ?? [])], {
    cwd: config.cwd ?? root,
    env: {
      ...process.env,
      MORRISCODE_INSTALL_FLAVOR: 'release',
      MORRISCODE_RELEASE_ROOT: root,
      MORRISCODE_RELEASE_DIR: state.dir,
      MORRISCODE_RELEASE_VERSION: state.version,
      ...(config.autoUpdate === false ? { MORRISCODE_AUTO_UPDATE_DEFAULT: 'false' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.pipe(output)
  child.stderr?.pipe(output)
  const exited = new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => resolvePromise({ code, signal }))
    child.on('error', (error) => resolvePromise({ code: 1, signal: null, error }))
  })
  return { child, exited, output, releaseDir }
}

async function restoreBackup(root, pending) {
  if (!pending?.backupDir) return
  const backupDir = resolve(root, pending.backupDir)
  if (!isWithinRoot(root, backupDir)) return
  const configDir = pending.configDir
  if (configDir) {
    for (const name of ['config.json', 'auth.json', 'auth.key']) {
      try {
        await copyFile(join(backupDir, name), join(configDir, name))
      } catch {
        // The file may not have existed before the update.
      }
    }
    const backupCerts = join(backupDir, 'certs')
    try {
      await stat(backupCerts)
      await mkdir(configDir, { recursive: true })
      await rm(join(configDir, 'certs'), { recursive: true, force: true })
      const { cp } = await import('node:fs/promises')
      await cp(backupCerts, join(configDir, 'certs'), { recursive: true })
    } catch {
      // No certificate snapshot; leave the existing directory untouched.
    }
  }
  if (pending.databasePath) {
    try {
      await stat(join(backupDir, 'sessions.db'))
      await rm(`${pending.databasePath}-wal`, { force: true })
      await rm(`${pending.databasePath}-shm`, { force: true })
      await copyFile(join(backupDir, 'sessions.db'), pending.databasePath)
    } catch {
      // The database may not have existed before the update; leave it untouched.
    }
  }
}

async function writeLastUpdate(root, record) {
  try {
    await atomicWrite(join(root, 'last-update.json'), record)
  } catch {
    // The record is informational; never fail the running release over it.
  }
}

async function pruneReleases(root, current, previous) {
  try {
    if (!previous) return
    const keep = new Set([current?.version, previous?.version].filter(Boolean))
    const releasesDir = join(root, 'releases')
    for (const entry of await readdir(releasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!/^\d+\.\d+\.\d+/.test(entry.name)) continue
      if (!keep.has(entry.name)) await rm(join(releasesDir, entry.name), { recursive: true, force: true })
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function run() {
  const root = resolve(process.env.MORRISCODE_RELEASE_ROOT ?? dirname(process.argv[1]))
  await mkdir(join(root, 'logs'), { recursive: true })
  const config = await readJson(join(root, 'launcher.json'), null)
  if (!config) {
    console.error(`Missing launcher configuration: ${join(root, 'launcher.json')}`)
    process.exit(1)
  }
  const currentPath = join(root, 'current.json')
  const restartPath = join(root, 'restart-requested.json')
  let child = null
  const stop = () => child?.kill('SIGTERM')
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  while (true) {
    const state = await readJson(currentPath, null)
    if (!state) {
      console.error(`Missing current release pointer: ${currentPath}`)
      process.exit(1)
    }

    let pending = state.pending ?? null
    let candidate = startChild(root, state, config)
    child = candidate.child
    await log(root, `started ${state.version} (${state.dir})`)

    if (pending) {
      const healthy = await waitUntilHealthy(
        config.healthPort ?? 10369,
        config.healthScheme ?? 'http',
        HEALTH_TIMEOUT_MS,
        state.version,
      )
      if (!healthy) {
        await log(root, `health check failed for ${state.version}; rolling back`)
        candidate.child.kill('SIGTERM')
        await candidate.exited
        await restoreBackup(root, pending)
        const previous = state.previous
        if (!previous) {
          await writeLastUpdate(root, {
            status: 'failed',
            version: state.version,
            message: 'The new release did not start and there is no previous release.',
            at: new Date().toISOString(),
          })
          process.exit(1)
        }
        await atomicWrite(currentPath, {
          schemaVersion: 1,
          version: previous.version,
          dir: previous.dir,
          updatedAt: new Date().toISOString(),
        })
        await writeLastUpdate(root, {
          status: 'failed',
          version: state.version,
          message: `The new release did not start; restored ${previous.version}.`,
          at: new Date().toISOString(),
        })
        await rm(join(root, 'staged.json'), { force: true }).catch(() => undefined)
        await rm(resolve(root, state.dir), { recursive: true, force: true }).catch(() => undefined)
        continue
      }

      const accepted = { ...state }
      delete accepted.pending
      await atomicWrite(currentPath, accepted)
      await writeLastUpdate(root, { status: 'success', version: state.version, at: new Date().toISOString() })
      await rm(join(root, 'staged.json'), { force: true }).catch(() => undefined)
      await pruneReleases(root, accepted, accepted.previous)
      await log(root, `${state.version} passed its health check`)
      pending = null
    }

    const result = await candidate.exited
    candidate.output.end()
    child = null
    await log(root, `${state.version} exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}`)

    let restartRequested = null
    try {
      restartRequested = JSON.parse(await readFile(restartPath, 'utf-8'))
      await rm(restartPath, { force: true })
    } catch {
      // No restart requested.
    }
    if (restartRequested) {
      await log(root, `restart requested for ${restartRequested.targetVersion}`)
      continue
    }
    process.exit(typeof result.code === 'number' ? result.code : 1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
