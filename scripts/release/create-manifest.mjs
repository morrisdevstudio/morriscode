#!/usr/bin/env node
/** Build and sign the manifest that every MorrisCode release publishes. */
import { createHash, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) values[name] = 'true'
    else {
      values[name] = value
      index += 1
    }
  }
  return values
}

function fail(message) {
  console.error(`[create-manifest] ${message}`)
  process.exit(1)
}

async function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const args = parseArgs(process.argv.slice(2))
for (const required of ['version', 'tag', 'commit', 'assets-dir', 'out', 'key-id']) {
  if (!args[required]) fail(`Missing --${required}`)
}

const version = args.version.replace(/^v/, '')
const assetsDir = args['assets-dir']
const files = await readdir(assetsDir)
const pattern = new RegExp(`^morriscode-${version.replaceAll('.', '\\.')}-(win32|linux)-(x64|arm64)\\.(zip|tar\\.gz)$`)
const assets = []
for (const filename of files) {
  const match = pattern.exec(filename)
  if (!match) continue
  const path = join(assetsDir, filename)
  const info = await stat(path)
  assets.push({
    platform: match[1],
    arch: match[2],
    filename,
    size: info.size,
    sha256: await sha256(path),
  })
}
if (assets.length === 0) fail('No release packages found in the assets directory')

const legacyPackageJson = JSON.parse(await readFile('package.json', 'utf-8'))
const manifest = {
  schemaVersion: 1,
  keyId: args['key-id'],
  version,
  tag: args.tag,
  commit: args.commit,
  publishedAt: new Date().toISOString(),
  minNode: `>=${String(legacyPackageJson.engines?.node ?? '24').replace(/^\^|^>=/, '')}`,
  assets,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(args.out, manifestBytes)

let privateKeyPem = process.env['RELEASE_SIGNING_KEY_PEM'] ?? ''
if (args['key-file']) {
  privateKeyPem = await readFile(args['key-file'], 'utf-8')
} else if (process.env['RELEASE_SIGNING_KEY']) {
  privateKeyPem = Buffer.from(process.env['RELEASE_SIGNING_KEY'], 'base64').toString('utf-8')
}
if (!privateKeyPem.trim()) fail('No signing key provided (use --key-file or RELEASE_SIGNING_KEY)')

const signature = sign(null, manifestBytes, privateKeyPem).toString('base64')
await writeFile(`${args.out}.sig`, `${signature}\n`)
console.log(`[create-manifest] wrote ${args.out} (${assets.length} package(s))`)
