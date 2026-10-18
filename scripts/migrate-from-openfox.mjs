#!/usr/bin/env node
/**
 * Migrate (and refresh) an existing OpenFox installation into MorrisCode.
 *
 * - config: auth.json, auth.key, plugins, skills and workflows are copied when absent;
 *   config.json is *merged* so every provider keeps every model it has in OpenFox, while
 *   providers and models added in MorrisCode are preserved.
 * - data: sessions.db is refreshed from a consistent snapshot of OpenFox's database (taken
 *   with SQLite's online backup API, so it is safe while OpenFox is running). The previous
 *   file is kept next to it as a timestamped .bak.
 * - project-level .openfox/ folders are copied to .morriscode/.
 *
 * OpenFox originals are never modified or deleted.
 *
 * Usage:
 *   node scripts/migrate-from-openfox.mjs [--dev] [--dry-run] [--project <path>]...
 *   --dev targets morriscode-dev, using the same production OpenFox source.
 *   Stop the destination MorrisCode server before refreshing its database.
 */

import { cp, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

/** Copied only when MorrisCode does not have them yet — config.json is merged instead. */
const CONFIG_ENTRIES = ['auth.json', 'auth.key', 'plugins', 'skills', 'workflows']

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function appDir(kind, name, env = process.env, os = platform(), home = homedir()) {
  if (os === 'darwin') {
    return join(home, 'Library', 'Application Support', name)
  }
  if (kind === 'config') {
    if (os === 'win32') return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), name)
    return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), name)
  }
  if (os === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), name)
  return join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), name)
}

function parseArgs(argv) {
  const projects = []
  let dryRun = false
  let dev = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--dev') {
      dev = true
    } else if (arg === '--project') {
      const value = argv[index + 1]
      if (!value) throw new Error('--project requires a path')
      projects.push(value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { dryRun, projects, dev }
}

async function copyEntry(source, destination, dryRun) {
  if (!existsSync(source)) return 'skipped (not present)'
  if (existsSync(destination)) return 'skipped (already present)'
  if (dryRun) return 'would copy'
  await cp(source, destination, { recursive: true, force: false, errorOnExist: false })
  return 'copied'
}

async function migrateDirectory(label, source, destination, entries, dryRun) {
  console.log(`${label}: ${source} -> ${destination}`)
  if (!existsSync(source)) {
    console.log('  source directory missing, nothing to do')
    return
  }
  for (const entry of entries) {
    const result = await copyEntry(join(source, entry), join(destination, entry), dryRun)
    console.log(`  ${entry}: ${result}`)
  }
}

/**
 * Union of the two provider lists: models missing from MorrisCode are appended, providers
 * only OpenFox knows about are added, and config keys MorrisCode never set are filled in.
 */
export function mergeConfigs(dest, source) {
  const merged = { ...dest }
  const filledKeys = []

  for (const [key, value] of Object.entries(source ?? {})) {
    if (key === 'providers') continue
    if (merged[key] === undefined) {
      merged[key] = value
      filledKeys.push(key)
    }
  }

  const providers = [...(dest.providers ?? [])]
  const addedModels = []
  const addedProviders = []

  for (const sourceProvider of source?.providers ?? []) {
    const index = providers.findIndex(
      (candidate) =>
        (candidate.id && sourceProvider.id && candidate.id === sourceProvider.id) ||
        (!candidate.id && candidate.name && candidate.name === sourceProvider.name),
    )

    if (index === -1) {
      providers.push(sourceProvider)
      addedProviders.push(sourceProvider.name ?? sourceProvider.id)
      continue
    }

    const current = providers[index]
    const known = new Set((current.models ?? []).map((model) => model?.id))
    const missing = (sourceProvider.models ?? []).filter((model) => model?.id && !known.has(model.id))
    if (missing.length === 0) continue

    providers[index] = { ...current, models: [...(current.models ?? []), ...missing] }
    addedModels.push({ provider: current.name ?? current.id, ids: missing.map((model) => model.id) })
  }

  merged.providers = providers
  return { config: merged, filledKeys, addedModels, addedProviders }
}

async function mergeConfigFile(sourcePath, destPath, dryRun) {
  if (!existsSync(sourcePath)) {
    console.log('  config.json: source missing, skipped')
    return
  }
  if (!existsSync(destPath)) {
    const result = await copyEntry(sourcePath, destPath, dryRun)
    console.log(`  config.json: ${result}`)
    return
  }

  const dest = JSON.parse(await readFile(destPath, 'utf8'))
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  const { config, filledKeys, addedModels, addedProviders } = mergeConfigs(dest, source)

  if (dryRun) {
    console.log('  config.json: would merge')
  } else {
    await copyFile(destPath, `${destPath}.pre-migrate-${timestamp()}.bak`)
    await writeFile(destPath, `${JSON.stringify(config, null, 2)}\n`)
    console.log('  config.json: merged (MorrisCode copy kept as .pre-migrate-*.bak)')
  }

  for (const entry of addedModels) {
    console.log(`    +${entry.ids.length} model(s) in "${entry.provider}": ${entry.ids.join(', ')}`)
  }
  for (const name of addedProviders) console.log(`    +provider "${name}"`)
  if (filledKeys.length) console.log(`    +missing config keys: ${filledKeys.join(', ')}`)
  if (!addedModels.length && !addedProviders.length && !filledKeys.length) {
    console.log('    already up to date')
  }
}

function readSessionStats(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare('select count(*) as count, max(updated_at) as last from sessions').get()
    const ids = db
      .prepare('select id from sessions')
      .all()
      .map((r) => r.id)
    return { count: row?.count ?? 0, last: row?.last ?? null, ids }
  } finally {
    db.close()
  }
}

/** Move a database (and its WAL sidecars) aside so the refreshed copy starts clean. */
async function keepAsBackup(destPath) {
  const suffix = `.pre-migrate-${timestamp()}.bak`
  await rename(destPath, `${destPath}${suffix}`)
  for (const sidecar of ['-wal', '-shm']) {
    if (existsSync(`${destPath}${sidecar}`)) await rename(`${destPath}${sidecar}`, `${destPath}${suffix}${sidecar}`)
  }
  return `${destPath}${suffix}`
}

export async function refreshSessionsDatabase(sourcePath, destPath, dryRun, log = console.log) {
  if (!existsSync(sourcePath)) {
    log('  sessions.db: source missing, skipped')
    return
  }

  const source = readSessionStats(sourcePath)
  const existing = existsSync(destPath) ? readSessionStats(destPath) : { count: 0, last: null, ids: [] }
  const onlyInDest = existing.ids.filter((id) => !source.ids.includes(id))

  log(
    `  sessions.db: OpenFox has ${source.count} session(s) (last ${source.last ?? 'n/a'}), MorrisCode has ${existing.count}`,
  )
  if (onlyInDest.length) {
    log(
      `    note: ${onlyInDest.length} session(s) exist only in MorrisCode (${onlyInDest.slice(0, 3).join(', ')}…) — kept in the backup, not in the refreshed file`,
    )
  }

  if (dryRun) {
    log('    would refresh from OpenFox')
    return
  }

  await mkdir(dirname(destPath), { recursive: true })
  const backupPath = existsSync(destPath) ? await keepAsBackup(destPath) : null

  // Online backup reads a consistent snapshot, so this is safe while OpenFox is running.
  const sourceDb = new Database(sourcePath, { readonly: true })
  try {
    await sourceDb.backup(destPath)
  } finally {
    sourceDb.close()
  }

  const refreshed = readSessionStats(destPath)
  log(`    refreshed: ${refreshed.count} session(s), last ${refreshed.last ?? 'n/a'}`)
  if (backupPath) log(`    previous file kept at ${backupPath}`)
}

async function migrateProject(directory, dryRun) {
  const target = resolve(directory)
  const source = join(target, '.openfox')
  const destination = join(target, '.morriscode')
  if (!existsSync(source)) {
    console.log(`project ${target}: no .openfox directory`)
    return
  }
  if (existsSync(destination)) {
    console.log(`project ${target}: .morriscode already exists, left untouched`)
    return
  }
  if (dryRun) {
    console.log(`project ${target}: would copy .openfox -> .morriscode`)
    return
  }
  await cp(source, destination, { recursive: true, force: false, errorOnExist: false })
  console.log(`project ${target}: copied .openfox -> .morriscode`)
}

async function main() {
  const { dryRun, projects, dev } = parseArgs(process.argv.slice(2))
  if (dryRun) console.log('dry run: nothing will be written\n')

  const sourceConfigDir = appDir('config', 'openfox')
  const target = dev ? 'morriscode-dev' : 'morriscode'
  const destConfigDir = appDir('config', target)
  const sourceDataDir = appDir('data', 'openfox')
  const destDataDir = appDir('data', target)

  await migrateDirectory('config', sourceConfigDir, destConfigDir, CONFIG_ENTRIES, dryRun)
  console.log(`config.json (merge): ${join(sourceConfigDir, 'config.json')} -> ${join(destConfigDir, 'config.json')}`)
  await mergeConfigFile(join(sourceConfigDir, 'config.json'), join(destConfigDir, 'config.json'), dryRun)

  console.log(`data (refresh): ${join(sourceDataDir, 'sessions.db')} -> ${join(destDataDir, 'sessions.db')}`)
  await refreshSessionsDatabase(join(sourceDataDir, 'sessions.db'), join(destDataDir, 'sessions.db'), dryRun)

  for (const project of projects) {
    await migrateProject(project, dryRun)
  }

  console.log('\ndone')
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
