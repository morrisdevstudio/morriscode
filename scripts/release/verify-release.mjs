#!/usr/bin/env node
/** Verify a MorrisCode release manifest and, optionally, its package. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

function fail(message) {
  console.error(`[verify-release] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      values[name] = 'true'
    } else {
      values[name] = value
      index += 1
    }
  }
  return values
}

async function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const args = parseArgs(process.argv.slice(2))
const manifestPath = args.manifest
const signaturePath = args.signature
const publicKeyPath = args['public-key']
if (!manifestPath || !signaturePath || !publicKeyPath) {
  fail('Usage: verify-release.mjs --manifest <file> --signature <file> --public-key <file> [--asset <file>]')
}

const manifestBytes = await readFile(manifestPath)
const signature = Buffer.from((await readFile(signaturePath, 'utf-8')).trim(), 'base64')
const publicKey = createPublicKey(await readFile(publicKeyPath, 'utf-8'))
if (!verify(null, manifestBytes, publicKey, signature)) fail('The manifest signature is not valid')

const manifest = JSON.parse(manifestBytes.toString('utf-8'))
if (manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) {
  fail('The manifest is malformed')
}

const platform = args.platform
const arch = args.arch
const candidate =
  platform && arch
    ? manifest.assets.find((asset) => asset.platform === platform && asset.arch === arch)
    : args.asset
      ? manifest.assets.find((asset) => asset.filename === basename(args.asset))
      : undefined

if ((platform || args.asset) && !candidate) fail('No matching release package in the manifest')

if (args.asset) {
  const info = await stat(args.asset)
  if (info.size !== candidate.size) fail(`Package size mismatch: expected ${candidate.size}, got ${info.size}`)
  const digest = await hashFile(args.asset)
  if (digest !== candidate.sha256) fail('Package checksum mismatch')
}

console.log(
  JSON.stringify(
    {
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      keyId: manifest.keyId,
      ...(candidate ? { filename: candidate.filename, size: candidate.size, sha256: candidate.sha256 } : {}),
    },
    null,
    2,
  ),
)
