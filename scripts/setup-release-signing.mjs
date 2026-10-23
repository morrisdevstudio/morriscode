#!/usr/bin/env node
/** Generate the Ed25519 release key pair once, outside the repository. */
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
let outputPath = join(homedir(), '.morriscode', 'release-signing.key')
let publicKeyOut = null
let updateCode = false
let keyId = 'release'
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--public-key-out') {
    publicKeyOut = args[index + 1] ?? null
    index += 1
  } else if (args[index] === '--update-code') {
    updateCode = true
  } else if (args[index] === '--key-id') {
    keyId = args[index + 1] ?? 'release'
    index += 1
  } else if (!args[index].startsWith('--')) {
    outputPath = args[index]
  }
}
const pair = generateKeyPairSync('ed25519')
const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, privateKeyPem, { encoding: 'utf-8', mode: 0o600 })
if (publicKeyOut) await writeFile(publicKeyOut, publicKeyPem, 'utf-8')
if (updateCode) {
  const trustedKeysPath = join(process.cwd(), 'src', 'server', 'update', 'trusted-keys.ts')
  await writeFile(
    trustedKeysPath,
    `export interface TrustedReleaseKey {\n  id: string\n  publicKeyPem: string\n}\n\n/** Public keys allowed to sign release manifests. */\nexport const TRUSTED_RELEASE_KEYS: TrustedReleaseKey[] = [\n  {\n    id: ${JSON.stringify(keyId)},\n    publicKeyPem: ${JSON.stringify(publicKeyPem)},\n  },\n]\n`,
    'utf-8',
  )
  console.log(`Updated trusted key: ${trustedKeysPath}`)
}

console.log(`Private key written to: ${outputPath}`)
console.log('Add its base64 form to the GitHub secret RELEASE_SIGNING_KEY:')
console.log(`  [Convert]::ToBase64String([IO.File]::ReadAllBytes('${outputPath}'))`)
console.log('')
console.log('Public key to paste into src/server/update/trusted-keys.ts:')
console.log(publicKeyPem)
