#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'

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

const args = parseArgs(process.argv.slice(2))
if (!args.version) {
  console.error('[extract-notes] Missing --version')
  process.exit(1)
}
const changelog = await readFile('CHANGELOG.md', 'utf-8').catch(() => '')
const version = args.version.replace(/^v/, '')
const lines = changelog.split(/\r?\n/)
const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?${version.replaceAll('.', '\\.')}\\]?\\s+`).test(line))
let body = `MorrisCode ${version}`
if (start !== -1) {
  const section = [lines[start]]
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break
    section.push(line)
  }
  body = section.join('\n').trim()
}
if (args.out) await writeFile(args.out, `${body}\n`, 'utf-8')
else console.log(body)
