import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mergeSessionHistories } from './merge-session-histories.mjs'

const schema = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE projects(id TEXT PRIMARY KEY, workdir TEXT UNIQUE, updated_at TEXT);
  CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT, updated_at TEXT);
  CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
    seq INTEGER, event_type TEXT, timestamp INTEGER, payload TEXT, UNIQUE(session_id, seq));
  CREATE TABLE workflow_executions(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), status TEXT);
  CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), prompt TEXT);
  CREATE TABLE task_links(task_id TEXT REFERENCES tasks(id), session_id TEXT, PRIMARY KEY(task_id, session_id));
  CREATE TABLE task_gates(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));
  CREATE TABLE task_gate_values(id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), gate_id TEXT, session_id TEXT);
  CREATE TABLE task_audit(id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), detail TEXT);
  CREATE TABLE project_task_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id), slot_limit INTEGER);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE notifications(id TEXT PRIMARY KEY, body TEXT);
  CREATE TABLE tombstones(session_id TEXT, seq INTEGER, timestamp INTEGER, UNIQUE(session_id, seq));
`

describe('offline session history consolidation', () => {
  let root: string
  let prod: string
  let incoming: string
  let target: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'morriscode-consolidation-'))
    prod = join(root, 'prod.db')
    incoming = join(root, 'incoming.db')
    target = join(root, 'merged.db')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function fixture(path: string, id = 'shared', payloads = ['first']) {
    const db = new Database(path)
    db.exec(schema)
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('project', '/workspace', '2026-01-01')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'project', 'History', '2026-01-01')
    payloads.forEach((payload, index) => {
      db.prepare('INSERT INTO events(session_id, seq, event_type, timestamp, payload) VALUES (?, ?, ?, ?, ?)').run(
        id,
        index + 1,
        'message',
        index + 100,
        JSON.stringify({ text: payload, sessionId: id }),
      )
    })
    return db
  }

  function rows(table: string) {
    const db = new Database(target, { readonly: true })
    try {
      return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
    } finally {
      db.close()
    }
  }

  it('backs up production and preserves every table, unique histories, and source bytes', async () => {
    fixture(prod, 'prod').close()
    const db = fixture(incoming, 'other')
    db.exec(`
      INSERT INTO tasks VALUES ('task','project','Keep me');
      INSERT INTO task_links VALUES ('task','other');
      INSERT INTO task_gates VALUES ('gate','project');
      INSERT INTO task_gate_values VALUES ('value','task','gate','other');
      INSERT INTO task_audit VALUES ('audit','task','audit detail');
      INSERT INTO project_task_settings VALUES ('project',3);
      INSERT INTO workflow_executions VALUES ('execution','other','done');
      INSERT INTO settings VALUES ('theme','dark');
      INSERT INTO notifications VALUES ('notification','Hello');
      INSERT INTO tombstones VALUES ('other',10,200);
      CREATE TABLE extra_data(key TEXT PRIMARY KEY, value BLOB);
      INSERT INTO extra_data VALUES ('extra',X'0102');
    `)
    db.close()
    const before = await Promise.all([readFile(prod), readFile(incoming)])
    await mergeSessionHistories([prod, incoming], target)
    expect(
      rows('sessions')
        .map((row) => row['id'])
        .sort(),
    ).toEqual(['other', 'prod'])
    expect(rows('events')).toHaveLength(2)
    for (const table of [
      'tasks',
      'task_links',
      'task_gates',
      'task_gate_values',
      'task_audit',
      'project_task_settings',
      'workflow_executions',
      'settings',
      'notifications',
      'tombstones',
      'extra_data',
    ]) {
      expect(rows(table), table).toHaveLength(1)
    }
    expect(await readFile(prod)).toEqual(before[0])
    expect(await readFile(incoming)).toEqual(before[1])
  })

  it('takes a longer prefix history even with older metadata, and retains newer metadata', async () => {
    const db = fixture(prod)
    db.exec("UPDATE sessions SET title='New title',updated_at='2026-03-01'")
    db.close()
    fixture(incoming, 'shared', ['first', 'second']).close()
    await mergeSessionHistories([prod, incoming, incoming], target)
    expect(rows('sessions')).toHaveLength(1)
    expect(rows('sessions')[0]?.['title']).toBe('New title')
    expect(rows('events').map((row) => row['seq'])).toEqual([1, 2])
  })

  it('uses newer session metadata for identical or shorter incoming streams', async () => {
    fixture(prod, 'shared', ['first', 'second']).close()
    const db = fixture(incoming)
    db.exec("UPDATE sessions SET title='Latest title',updated_at='2026-05-01'")
    db.close()
    await mergeSessionHistories([prod, incoming], target)
    expect(rows('events')).toHaveLength(2)
    expect(rows('sessions')[0]?.['title']).toBe('Latest title')
  })

  it.each(['payload', 'event_type', 'timestamp', 'seq'])(
    'clones divergence in %s deterministically and remaps dependencies',
    async (column) => {
      const first = fixture(prod)
      first.exec("INSERT INTO workflow_executions VALUES ('execution','shared','running')")
      first.close()
      const db = fixture(incoming)
      const payload = JSON.stringify({
        sessionId: 'shared',
        nested: [{ sessionId: 'shared', text: 'shared' }],
        other: { sessionId: 'unrelated' },
      })
      db.prepare('UPDATE events SET payload=?').run(payload)
      if (column !== 'payload') {
        // Keep payload identical so each stream field is tested independently.
        const base = new Database(prod)
        base.prepare('UPDATE events SET payload=?').run(payload)
        base.close()
        db.prepare(`UPDATE events SET ${column}=?`).run(column === 'event_type' ? 'different' : 999)
      }
      db.exec(`
      INSERT INTO workflow_executions VALUES ('execution','shared','done');
      INSERT INTO tasks VALUES ('task','project','Keep me');
      INSERT INTO task_links VALUES ('task','shared');
      INSERT INTO task_gates VALUES ('gate','project');
      INSERT INTO task_gate_values VALUES ('value','task','gate','shared');
      INSERT INTO tombstones VALUES ('shared',10,200);
    `)
      db.close()
      const report = await mergeSessionHistories(
        [prod, { path: incoming, label: 'OpenFox' }, { path: incoming, label: 'OpenFox' }],
        target,
      )
      const clone = rows('sessions').find((row) => row['id'] !== 'shared')!
      expect(clone['id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(clone['title']).toBe('History [OpenFox]')
      expect(rows('sessions')).toHaveLength(2)
      expect(rows('events')).toHaveLength(2)
      for (const table of ['task_links', 'task_gate_values', 'tombstones']) {
        expect(rows(table)[0]?.['session_id']).toBe(clone['id'])
      }
      expect(rows('workflow_executions')).toHaveLength(2)
      expect(rows('workflow_executions').some((row) => row['session_id'] === clone['id'])).toBe(true)
      const event = rows('events').find((row) => row['session_id'] === clone['id'])!
      expect(JSON.parse(event['payload'] as string)).toEqual({
        sessionId: clone['id'],
        nested: [{ sessionId: clone['id'], text: 'shared' }],
        other: { sessionId: 'unrelated' },
      })
      expect(report.clones.length).toBeGreaterThan(0)
      const secondTarget = join(root, 'second.db')
      await mergeSessionHistories([prod, { path: incoming, label: 'OpenFox' }], secondTarget)
      const second = new Database(secondTarget)
      expect(second.prepare("SELECT id FROM sessions WHERE id <> 'shared'").get()).toEqual({ id: clone['id'] })
      expect(second.pragma('foreign_key_check')).toEqual([])
      expect(second.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      second.close()
    },
  )

  it('reports settings conflicts without overwriting production values', async () => {
    const first = fixture(prod)
    first.exec("INSERT INTO settings VALUES ('theme','dark')")
    first.close()
    const next = fixture(incoming)
    next.exec("INSERT INTO settings VALUES ('theme','light')")
    next.close()
    const report = await mergeSessionHistories([prod, incoming], target)
    expect(rows('settings')).toEqual([{ key: 'theme', value: 'dark' }])
    expect(report.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'settings' })]))
    expect(JSON.stringify(report)).not.toContain('light')
  })

  it('preserves colliding task, gate, audit and execution identities with their dependent links', async () => {
    for (const [path, text] of [
      [prod, 'production'],
      [incoming, 'incoming'],
    ] as const) {
      const db = fixture(path)
      db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('task', 'project', text)
      db.exec(`
        INSERT INTO task_links VALUES ('task','shared');
        INSERT INTO task_gates VALUES ('gate','project');
        INSERT INTO task_gate_values VALUES ('value','task','gate','shared');
      `)
      db.prepare('INSERT INTO workflow_executions VALUES (?,?,?)').run('execution', 'shared', text)
      db.prepare('INSERT INTO task_audit VALUES (?,?,?)').run('audit', 'task', text)
      db.close()
    }
    await mergeSessionHistories([prod, incoming, incoming], target)
    expect(rows('tasks')).toHaveLength(2)
    const task = rows('tasks').find((row) => row['prompt'] === 'incoming')!
    expect(rows('task_links')).toHaveLength(2)
    expect(rows('task_links').some((row) => row['task_id'] === task['id'])).toBe(true)
    expect(rows('task_gate_values').some((row) => row['task_id'] === task['id'])).toBe(true)
    expect(rows('task_audit').find((row) => row['detail'] === 'incoming')?.['task_id']).toBe(task['id'])
    expect(rows('workflow_executions')).toHaveLength(2)
  })

  it('refuses an existing destination, including a source path', async () => {
    fixture(prod).close()
    await writeFile(target, 'existing destination')
    await expect(mergeSessionHistories([prod], target)).rejects.toThrow(/exist/i)
    expect(await readFile(target, 'utf8')).toBe('existing destination')
    await expect(mergeSessionHistories([prod], prod)).rejects.toThrow(/exist/i)
  })

  it('rolls back and cleans up on an unknown unsafe conflict', async () => {
    const first = fixture(prod)
    first.exec(
      "CREATE TABLE unknown_data(id TEXT PRIMARY KEY,value TEXT); INSERT INTO unknown_data VALUES ('key','original')",
    )
    first.close()
    const next = fixture(incoming, 'unique')
    next.exec(
      "CREATE TABLE unknown_data(id TEXT PRIMARY KEY,value TEXT); INSERT INTO unknown_data VALUES ('key','different')",
    )
    next.close()
    const before = await readFile(prod)
    await expect(mergeSessionHistories([prod, incoming], target)).rejects.toThrow(/unsafe conflict.*unknown_data/i)
    expect((await readdir(root)).sort()).toEqual(['incoming.db', 'prod.db'])
    expect(await readFile(prod)).toEqual(before)
  })

  it('rejects broken foreign keys and removes the failed destination', async () => {
    const db = fixture(prod)
    db.pragma('foreign_keys=OFF')
    db.exec("INSERT INTO workflow_executions VALUES ('orphan','missing','done')")
    db.close()
    await expect(mergeSessionHistories([prod], target)).rejects.toThrow(/foreign.key/i)
    expect(await readdir(root)).toEqual(['prod.db'])
  })

  it('remaps cross-session payload references without making extra clones on repeated inputs', async () => {
    fixture(prod).close()
    const db = fixture(incoming, 'shared', ['divergent'])
    db.exec("INSERT INTO sessions VALUES ('child','project','Child','2026-01-01')")
    db.prepare('INSERT INTO events(session_id,seq,event_type,timestamp,payload) VALUES (?,?,?,?,?)').run(
      'child',
      1,
      'message',
      100,
      JSON.stringify({ sessionId: 'child', parent: { sessionId: 'shared' } }),
    )
    db.close()
    await mergeSessionHistories([prod, incoming, incoming], target)
    expect(rows('sessions')).toHaveLength(3)
    expect(rows('events')).toHaveLength(3)
    const clone = rows('sessions').find((row) => row['id'] !== 'shared' && row['id'] !== 'child')!
    const childEvent = rows('events').find((row) => row['session_id'] === 'child')!
    expect(JSON.parse(childEvent['payload'] as string).parent.sessionId).toBe(clone['id'])
  })

  it('rejects project identity conflicts rather than assigning histories to a different directory', async () => {
    fixture(prod).close()
    const db = fixture(incoming, 'other')
    db.exec("UPDATE projects SET workdir='/different-project'")
    db.close()
    await expect(mergeSessionHistories([prod, incoming], target)).rejects.toThrow(/unsafe conflict.*projects/i)
    expect((await readdir(root)).sort()).toEqual(['incoming.db', 'prod.db'])
  })

  it('does not silently replace an existing session whose id collides with a generated clone id', async () => {
    fixture(prod).close()
    fixture(incoming, 'shared', ['different']).close()
    await mergeSessionHistories([prod, incoming], target)
    const clone = rows('sessions').find((row) => row['id'] !== 'shared')!
    const db = new Database(prod)
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(clone['id'], 'project', 'Unrelated', '2026-01-01')
    db.close()
    await expect(mergeSessionHistories([prod, incoming], join(root, 'collision.db'))).rejects.toThrow(/collision/i)
  })

  it('fails closed on schema differences and triggers, leaving sources intact', async () => {
    fixture(prod).close()
    const db = fixture(incoming)
    db.exec('ALTER TABLE sessions ADD COLUMN extra TEXT')
    db.close()
    await expect(mergeSessionHistories([prod, incoming], target)).rejects.toThrow(/incompatible schema/i)
    const first = new Database(prod)
    first.exec('CREATE TRIGGER alter_history AFTER INSERT ON events BEGIN DELETE FROM events; END')
    first.close()
    await expect(mergeSessionHistories([prod], target)).rejects.toThrow(/trigger/i)
    expect((await readdir(root)).sort()).toEqual(['incoming.db', 'prod.db'])
  })

  it('requires existing source files and explicit CLI paths', async () => {
    await expect(mergeSessionHistories([prod], target)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
    await expect(promisify(execFile)(process.execPath, ['scripts/merge-session-histories.mjs'])).rejects.toMatchObject({
      code: 1,
    })
    fixture(prod).close()
    const { stdout } = await promisify(execFile)(process.execPath, [
      'scripts/merge-session-histories.mjs',
      '--source',
      prod,
      '--destination',
      target,
    ])
    expect(JSON.parse(stdout).checks).toEqual({ integrity: true, foreignKeys: true })
    expect(rows('sessions')).toHaveLength(1)
  })

  it('backs up uncheckpointed WAL data without changing either source file', async () => {
    const db = fixture(prod)
    try {
      db.pragma('journal_mode=WAL')
      db.pragma('wal_autocheckpoint=0')
      db.exec("UPDATE sessions SET title='Still in WAL'")
      const before = await Promise.all([readFile(prod), readFile(prod + '-wal')])
      await mergeSessionHistories([prod], target)
      expect(rows('sessions')[0]?.['title']).toBe('Still in WAL')
      expect(await readFile(prod)).toEqual(before[0])
      expect(await readFile(prod + '-wal')).toEqual(before[1])
    } finally {
      db.close()
    }
  })

  it('uses the Development label and preserves integers larger than JavaScript safe integers', async () => {
    fixture(prod).close()
    const db = fixture(incoming, 'shared', ['development'])
    db.exec('UPDATE events SET timestamp=9007199254740993')
    db.close()
    await mergeSessionHistories([prod, { path: incoming, label: 'Development' }], target)
    expect(rows('sessions').some((row) => row['title'] === 'History [Development]')).toBe(true)
    const result = new Database(target, { readonly: true })
    try {
      expect(result.prepare('SELECT MAX(timestamp) AS timestamp FROM events').safeIntegers().get()).toEqual({
        timestamp: 9007199254740993n,
      })
    } finally {
      result.close()
    }
  })

  it('refuses to adopt or remove a pre-existing destination sidecar', async () => {
    fixture(prod).close()
    await writeFile(target + '-wal', 'unrelated sidecar')
    await expect(mergeSessionHistories([prod], target)).rejects.toThrow(/exist/i)
    expect(await readFile(target + '-wal', 'utf8')).toBe('unrelated sidecar')
    expect((await readdir(root)).sort()).toEqual(['merged.db-wal', 'prod.db'])
  })
})
