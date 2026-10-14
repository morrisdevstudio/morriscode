#!/usr/bin/env node
/**
 * Migrate an existing OpenFox installation to MorrisCode.
 *
 * Copies the OpenFox configuration (and session data) directory into MorrisCode's own
 * directories, and copies project-level `.openfox/` folders to `.morriscode/`.
 * The OpenFox originals are never modified or deleted.
 *
 * Usage:
 *   node scripts/migrate-from-openfox.mjs [--dry-run] [--project <path>]...
 */

import { cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

const CONFIG_ENTRIES = ['config.json', 'auth.json', 'auth.key', 'plugins', 'skills', 'workflows']
const DATA_ENTRIES = ['sessions.db']

function appDir(kind, name, env = process.env) {
  const home = homedir()
  const os = platform()
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--project') {
      const value = argv[index + 1]
      if (!value) throw new Error('--project requires a path')
      projects.push(value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { dryRun, projects }
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
  const { dryRun, projects } = parseArgs(process.argv.slice(2))
  if (dryRun) console.log('dry run: nothing will be written\n')

  await migrateDirectory('config', appDir('config', 'openfox'), appDir('config', 'morriscode'), CONFIG_ENTRIES, dryRun)
  await migrateDirectory('data', appDir('data', 'openfox'), appDir('data', 'morriscode'), DATA_ENTRIES, dryRun)

  for (const project of projects) {
    await migrateProject(project, dryRun)
  }

  console.log('\ndone')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
