/**
 * Offline, fail-closed consolidation. Stop applications before taking inputs.
 * The first source is authoritative for conflicting settings/project metadata.
 * Inputs are opened read-only and read through SQLite backups, never migrated.
 * Incompatible schemas, triggers and ambiguous row conflicts require manual review.
 * Reports contain identifiers, never settings values or event contents.
 *
 * node scripts/merge-session-histories.mjs --destination NEW.db \
 *   --source PROD.db --source OPENFOX.db --label OpenFox --source DEV.db --label Development
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const quote = (name) => `"${name.replaceAll('"', '""')}"`
const equal = (a, b) => {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  }
  return a === b
}
const read = (db, sql, ...args) =>
  db
    .prepare(sql)
    .safeIntegers()
    .all(...args)
const tables = (db) =>
  db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
const columns = (db, table) => db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all()
const keys = (db, table) =>
  columns(db, table)
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
const rows = (db, table) => {
  const order = keys(db, table)
  return read(db, `SELECT * FROM ${quote(table)}${order.length ? ` ORDER BY ${order.map(quote).join(',')}` : ''}`)
}
const stream = (db, id) =>
  read(db, 'SELECT seq, event_type, timestamp, payload FROM events WHERE session_id=? ORDER BY seq', id)
const prefix = (a, b) => a.length <= b.length && a.every((event, index) => equal(event, b[index]))

function deterministicId(table, id, content) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([table, id, content], (_, value) =>
        typeof value === 'bigint' ? { integer: value.toString() } : value,
      ),
    )
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function remapJson(value, mapping) {
  if (Array.isArray(value)) return value.map((item) => remapJson(item, mapping))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'sessionId' && typeof item === 'string' ? (mapping.get(item) ?? item) : remapJson(item, mapping),
      ]),
    )
  }
  return value
}

function remapPayload(payload, mapping) {
  if (![...mapping].some(([from, to]) => from !== to)) return payload
  const parsed = JSON.parse(payload)
  const remapped = remapJson(parsed, mapping)
  return equal(parsed, remapped) ? payload : JSON.stringify(remapped)
}

function validate(db) {
  if (db.pragma('integrity_check').some((row) => row.integrity_check !== 'ok'))
    throw new Error('SQLite integrity_check failed')
  if (db.pragma('foreign_key_check').length) throw new Error('SQLite foreign_key_check failed')
  if (!tables(db).some((table) => table.name === 'sessions') || !tables(db).some((table) => table.name === 'events')) {
    throw new Error('Source must contain sessions and events tables')
  }
  // Older EventStore schemas did not declare this foreign key.
  if (db.prepare('SELECT 1 FROM events e LEFT JOIN sessions s ON s.id=e.session_id WHERE s.id IS NULL LIMIT 1').get()) {
    throw new Error('Events contain an orphan session (foreign key violation)')
  }
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()) {
    throw new Error('Triggers require manual review before consolidation')
  }
}

function mergeSchema(dest, source) {
  for (const { name, sql } of tables(source)) {
    const existing = dest.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name)
    if (!existing) dest.exec(sql)
    else if (!equal(columns(dest, name), columns(source, name)) || existing.sql !== sql) {
      throw new Error(`Incompatible schema: ${name}`)
    }
  }
  for (const object of source
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('index','view') AND sql IS NOT NULL ORDER BY type,name",
    )
    .all()) {
    const existing = dest.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(object.name)
    if (!existing) dest.exec(object.sql)
    else if (existing.sql !== object.sql) throw new Error(`Incompatible schema object: ${object.name}`)
  }
}

function insert(db, table, row) {
  const names = columns(db, table)
    .filter((c) => !c.hidden && Object.hasOwn(row, c.name))
    .map((c) => c.name)
  db.prepare(
    `INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
  ).run(...names.map((name) => row[name]))
}

function find(db, table, row, primary = keys(db, table)) {
  if (!primary.length) throw new Error(`Cannot safely merge table without primary key: ${table}`)
  return read(
    db,
    `SELECT * FROM ${quote(table)} WHERE ${primary.map((key) => `${quote(key)} IS ?`).join(' AND ')}`,
    ...primary.map((key) => row[key]),
  )[0]
}

function newer(incoming, existing) {
  if (incoming.updated_at == null) return false
  if (existing.updated_at == null) return true
  const time = (value) => (typeof value === 'bigint' || typeof value === 'number' ? Number(value) : Date.parse(value))
  return time(incoming.updated_at) > time(existing.updated_at)
}

function mergeSource(dest, source, label, report) {
  mergeSchema(dest, source)
  const mappings = new Map([['sessions', new Map()]])
  const sessionMapping = mappings.get('sessions')
  const plans = []
  for (const session of rows(source, 'sessions')) {
    const incoming = stream(source, session.id)
    const existing = find(dest, 'sessions', session)
    sessionMapping.set(session.id, session.id)
    plans.push({ session, incoming, current: existing ? stream(dest, session.id) : undefined, id: session.id })
  }
  // Resolve cross-session references before comparing replayed inputs. When
  // comparing an original identity, its own sessionId must remain original.
  let stable = false
  for (let pass = 0; pass <= plans.length + 1; pass++) {
    const next = new Map()
    for (const plan of plans) {
      const comparisonMapping = new Map(sessionMapping)
      comparisonMapping.set(plan.session.id, plan.session.id)
      const incoming = plan.incoming.map((event) => ({
        ...event,
        payload: remapPayload(event.payload, comparisonMapping),
      }))
      plan.id =
        plan.current && !prefix(incoming, plan.current) && !prefix(plan.current, incoming)
          ? deterministicId('sessions', plan.session.id, plan.incoming)
          : plan.session.id
      next.set(plan.session.id, plan.id)
    }
    stable = [...next].every(([from, to]) => sessionMapping.get(from) === to)
    for (const [from, to] of next) sessionMapping.set(from, to)
    if (stable) break
  }
  if (!stable) throw new Error('Ambiguous cross-session history references require manual review')
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length)
    throw new Error('Deterministic session identity collision')

  function transform(table, original) {
    const row = { ...original }
    for (const fk of source.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
      const mapped = mappings.get(fk.table)?.get(row[fk.from])
      if (mapped !== undefined) row[fk.from] = mapped
    }
    if (Object.hasOwn(row, 'session_id'))
      row.session_id = sessionMapping.get(original.session_id) ?? original.session_id
    // This relationship is deliberately not declared as a foreign key in MorrisCode.
    if (Object.hasOwn(row, 'gate_id'))
      row.gate_id = mappings.get('task_gates')?.get(original.gate_id) ?? original.gate_id
    return row
  }

  const completed = new Set(['sessions', 'events'])
  const remaining = tables(source)
    .map((table) => table.name)
    .filter((name) => !completed.has(name))
  // Projects must exist before sessions. Other references are deferred until commit.
  const ordered = []
  while (remaining.length) {
    const index = remaining.findIndex((table) => {
      const parents = source
        .prepare(`PRAGMA foreign_key_list(${quote(table)})`)
        .all()
        .map((fk) => fk.table)
      if (table === 'task_gate_values') parents.push('task_gates')
      return parents.every((parent) => parent === table || !remaining.includes(parent))
    })
    if (index < 0) throw new Error('Cyclic table dependencies require manual review')
    ordered.push(...remaining.splice(index, 1))
  }

  function mergeTable(table) {
    const mapping = new Map()
    mappings.set(table, mapping)
    const primary = table === 'tombstones' ? ['session_id', 'seq'] : keys(source, table)
    for (const original of rows(source, table)) {
      const row = transform(table, original)
      const existing = find(dest, table, row, primary)
      if (existing && !equal(existing, row)) {
        if (table === 'projects' && row.workdir !== existing.workdir) throw new Error('Unsafe conflict in projects')
        if (['settings', 'projects', 'project_task_settings', 'task_links', 'tombstones'].includes(table)) {
          report.conflicts.push({
            source: label,
            table,
            key: primary.map((key) => String(row[key])),
            resolution: 'kept-destination',
          })
          continue
        }
        // These domain rows have independent text identities. Preserve both versions
        // and carry the new identity into dependent rows in topological order.
        if (
          ['workflow_executions', 'tasks', 'task_gates', 'task_gate_values', 'task_audit', 'notifications'].includes(
            table,
          ) &&
          primary.length === 1 &&
          primary[0] === 'id' &&
          typeof original.id === 'string'
        ) {
          row.id = deterministicId(table, original.id, row)
          mapping.set(original.id, row.id)
          const clone = find(dest, table, row)
          if (clone && !equal(clone, row)) throw new Error(`Unsafe conflict in ${table}`)
          if (!clone) insert(dest, table, row)
          continue
        }
        throw new Error(`Unsafe conflict in ${table}`)
      }
      if (!existing) insert(dest, table, row)
    }
  }

  for (const table of ordered.filter((table) => table === 'projects')) mergeTable(table)
  for (const { session, id, incoming } of plans) {
    const row = transform('sessions', session)
    row.id = id
    if (id !== session.id) row.title = `${session.title ?? 'Untitled'} [${label}]`
    const existing = find(dest, 'sessions', row)
    if (existing && existing.project_id !== row.project_id)
      throw new Error('Unsafe conflict in sessions project identity')
    if (existing && id !== session.id) {
      const expected = incoming.map((event) => ({ ...event, payload: remapPayload(event.payload, sessionMapping) }))
      if (existing.project_id !== row.project_id || !equal(stream(dest, id), expected)) {
        throw new Error('Deterministic session identity collision')
      }
    }
    if (!existing) {
      insert(dest, 'sessions', row)
      if (id !== session.id) report.clones.push({ source: label, originalId: session.id, clonedId: id })
    } else if (newer(row, existing)) {
      const names = columns(dest, 'sessions')
        .filter((c) => !c.pk && !c.hidden)
        .map((c) => c.name)
      dest
        .prepare(`UPDATE sessions SET ${names.map((name) => `${quote(name)}=?`).join(',')} WHERE id=?`)
        .run(...names.map((name) => row[name]), id)
    }
  }

  for (const { session, id } of plans) {
    const current = stream(dest, id)
    const incomingRows = read(source, 'SELECT * FROM events WHERE session_id=? ORDER BY seq', session.id)
    const transformed = incomingRows.map((original) => {
      const row = transform('events', original)
      delete row.id // SQLite integer event identities are local to each database.
      row.payload = remapPayload(row.payload, sessionMapping)
      return row
    })
    const incoming = transformed.map(({ seq, event_type, timestamp, payload }) => ({
      seq,
      event_type,
      timestamp,
      payload,
    }))
    if (!prefix(current, incoming) && !prefix(incoming, current))
      throw new Error('Deterministic session identity collision or incompatible remapped history')
    for (const row of transformed.slice(current.length)) insert(dest, 'events', row)
  }
  for (const table of ordered.filter((table) => table !== 'projects')) mergeTable(table)
}

export async function mergeSessionHistories(sourcePaths, destinationPath) {
  if (
    !Array.isArray(sourcePaths) ||
    !sourcePaths.length ||
    typeof destinationPath !== 'string' ||
    !destinationPath.trim()
  ) {
    throw new Error('Explicit sources and a new destination path are required')
  }
  const sources = sourcePaths.map((source, index) => {
    const path = typeof source === 'string' ? source : source?.path
    const label = typeof source === 'object' ? source?.label : undefined
    if (
      typeof path !== 'string' ||
      !path.trim() ||
      (label !== undefined && (typeof label !== 'string' || !label.trim()))
    ) {
      throw new Error('Each source requires a path and an optional non-empty label')
    }
    return {
      path: resolve(path),
      label: label ?? (index === 0 ? 'Production' : index === 1 ? 'OpenFox' : 'Development'),
    }
  })
  const destination = resolve(destinationPath)
  // Never adopt or delete pre-existing SQLite sidecars, either.
  for (const path of [destination, ...['-wal', '-shm', '-journal'].map((suffix) => destination + suffix)]) {
    try {
      await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    throw new Error('Destination or its SQLite sidecar already exists')
  }
  const reservation = await open(destination, 'wx')
  await reservation.close()
  let dest
  let scratch
  let succeeded = false
  const report = { clones: [], conflicts: [], checks: { integrity: false, foreignKeys: false } }
  try {
    scratch = await mkdtemp(resolve(dirname(destination), '.merge-session-histories-'))
    for (const [index, source] of sources.entries()) {
      const snapshotPath = index === 0 ? destination : resolve(scratch, `${index}.db`)
      const input = new Database(source.path, { readonly: true, fileMustExist: true })
      try {
        await input.backup(snapshotPath)
      } finally {
        input.close()
      }
      const snapshot = new Database(snapshotPath, { fileMustExist: true })
      snapshot.pragma('trusted_schema=OFF')
      if (index === 0) {
        dest = snapshot
        validate(dest)
        dest.pragma('foreign_keys=ON')
        dest.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON')
      } else {
        try {
          validate(snapshot)
          mergeSource(dest, snapshot, source.label, report)
        } finally {
          snapshot.close()
        }
      }
    }
    validate(dest)
    dest.exec('COMMIT')
    report.checks = { integrity: true, foreignKeys: true }
    dest.close()
    dest = undefined
    succeeded = true
    return report
  } finally {
    try {
      if (dest?.open) {
        try {
          if (dest.inTransaction) dest.exec('ROLLBACK')
        } finally {
          dest.close()
        }
      }
    } finally {
      if (!succeeded) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(destination + suffix, { force: true })
      }
      if (scratch) await rm(scratch, { recursive: true, force: true })
    }
  }
}

async function main(args) {
  const sources = []
  let destination
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('Every option requires an explicit value')
    if (flag === '--destination' && destination === undefined) destination = value
    else if (flag === '--source') sources.push({ path: value })
    else if (flag === '--label' && sources.length && sources.at(-1).label === undefined) sources.at(-1).label = value
    else throw new Error(`Unknown or repeated option: ${flag}`)
  }
  console.log(JSON.stringify(await mergeSessionHistories(sources, destination), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    // SQLite errors can include data. Do not print rows, queries, or payloads.
    console.error(error.code?.startsWith('SQLITE_') ? `Consolidation failed (${error.code})` : error.message)
    process.exitCode = 1
  })
}
