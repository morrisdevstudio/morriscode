import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FirstRunSetupFlags } from './main.js'

const TEST_DIR = join(tmpdir(), 'morriscode-network-setup-test-' + Date.now())

vi.mock('./paths.js', () => ({
  getGlobalConfigDir: () => TEST_DIR,
  getGlobalConfigPath: () => join(TEST_DIR, 'config.json'),
  getAuthConfigPath: () => join(TEST_DIR, 'auth.json'),
  getAuthKeyPath: () => join(TEST_DIR, 'auth.key'),
}))

const mockCancelToken = Symbol('clack-cancel')
const mockSelect = vi.fn()
const mockPassword = vi.fn()
const mockConfirm = vi.fn()
const mockCancel = vi.fn()

vi.mock('@clack/prompts', () => ({
  select: mockSelect,
  password: mockPassword,
  confirm: mockConfirm,
  isCancel: (value: unknown) => value === mockCancelToken,
  cancel: mockCancel,
}))

const ORIGINAL_NON_INTERACTIVE = process.env['MORRISCODE_NONINTERACTIVE']

/** Fakes (or removes) a TTY on stdio, the way a real terminal or a pipe would. */
function stubTerminal(tty: boolean): () => void {
  const restore: Array<() => void> = []
  for (const stream of [process.stdin, process.stdout] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY')
    Object.defineProperty(stream, 'isTTY', { value: tty, configurable: true })
    restore.push(() => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor)
      else delete (stream as unknown as Record<string, unknown>)['isTTY']
    })
  }
  return () => {
    for (const undo of restore) undo()
  }
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(TEST_DIR, name), 'utf-8'))
}

async function runSetup(flags: FirstRunSetupFlags = {}): Promise<void> {
  const { runNetworkSetup } = await import('./main.js')
  await runNetworkSetup('development', flags)
}

describe('first-run network setup', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await rm(TEST_DIR, { recursive: true, force: true })
    delete process.env['MORRISCODE_NONINTERACTIVE']
  })

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    if (ORIGINAL_NON_INTERACTIVE === undefined) delete process.env['MORRISCODE_NONINTERACTIVE']
    else process.env['MORRISCODE_NONINTERACTIVE'] = ORIGINAL_NON_INTERACTIVE
  })

  it('configures localhost without prompting when no terminal is attached', async () => {
    const restore = stubTerminal(false)
    try {
      await runSetup()
    } finally {
      restore()
    }

    // Regression guard: a prompt here is unanswerable, so it must never be rendered.
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockPassword).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()

    expect(await readJson('config.json')).toMatchObject({
      server: { host: '127.0.0.1', https: false, port: 10469 },
    })
    expect(await readJson('auth.json')).toMatchObject({ strategy: 'local', encryptedPassword: null })
  })

  it('skips the prompt when a watcher owns stdin (MORRISCODE_NONINTERACTIVE=1)', async () => {
    // The dev script runs the CLI under tsx watch, which restarts the process on every
    // keystroke, so a prompt is unusable even though stdin is a TTY.
    process.env['MORRISCODE_NONINTERACTIVE'] = '1'
    const restore = stubTerminal(true)
    try {
      await runSetup()
    } finally {
      restore()
    }

    expect(mockSelect).not.toHaveBeenCalled()
    expect(await readJson('config.json')).toMatchObject({ server: { host: '127.0.0.1', https: false } })
  })

  it('applies --network from the command line without prompting', async () => {
    const restore = stubTerminal(true)
    try {
      await runSetup({ network: true, password: 'sekret' })
    } finally {
      restore()
    }

    expect(mockSelect).not.toHaveBeenCalled()
    expect(await readJson('config.json')).toMatchObject({ server: { host: '0.0.0.0', https: true } })
    expect(await readJson('auth.json')).toMatchObject({ strategy: 'network', encryptedPassword: expect.any(String) })
  })

  it('applies --host and --https from the command line', async () => {
    const restore = stubTerminal(true)
    try {
      await runSetup({ host: '0.0.0.0', https: true, password: 'sekret' })
    } finally {
      restore()
    }

    expect(mockSelect).not.toHaveBeenCalled()
    expect(await readJson('config.json')).toMatchObject({ server: { host: '0.0.0.0', https: true } })
  })

  it('stores --https-cert and --https-key and enables HTTPS', async () => {
    const restore = stubTerminal(true)
    try {
      await runSetup({ httpsCert: '/certs/server.crt', httpsKey: '/certs/server.key' })
    } finally {
      restore()
    }

    expect(mockSelect).not.toHaveBeenCalled()
    expect(await readJson('config.json')).toMatchObject({
      server: { https: true, httpsCert: '/certs/server.crt', httpsKey: '/certs/server.key' },
    })
  })

  it.each([
    { network: true },
    { host: '192.168.1.8', password: '' },
    { network: true, noHttps: true, password: 'sekret' },
    { network: true, noHttps: true, https: true, password: 'sekret' },
  ])('rejects unsafe network setup before writing credentials: %j', async (flags) => {
    await expect(runSetup(flags)).rejects.toThrow(/HTTPS|password|mot de passe/)
    await expect(access(join(TEST_DIR, 'auth.json'))).rejects.toThrow()
    await expect(access(join(TEST_DIR, 'config.json'))).rejects.toThrow()
  })

  it('requires a password for an interactive network setup', async () => {
    mockSelect.mockResolvedValue('network')
    mockPassword.mockResolvedValue('')
    const restore = stubTerminal(true)
    try {
      await expect(runSetup()).rejects.toThrow(/password|mot de passe/)
    } finally {
      restore()
    }
    await expect(access(join(TEST_DIR, 'auth.json'))).rejects.toThrow()
  })

  it('encrypts --password into the auth config', async () => {
    const restore = stubTerminal(true)
    try {
      await runSetup({ password: 'sekret' })
    } finally {
      restore()
    }

    expect(mockPassword).not.toHaveBeenCalled()
    const auth = await readJson('auth.json')
    expect(auth['strategy']).toBe('network')
    const encrypted = auth['encryptedPassword']
    expect(typeof encrypted).toBe('string')
    expect((encrypted as string).length).toBeGreaterThan(0)

    const key = await readFile(join(TEST_DIR, 'auth.key'), 'utf-8')
    expect(key).toContain('-----BEGIN PRIVATE KEY-----')
  })

  it('still prompts on an interactive terminal and saves the answers', async () => {
    mockSelect.mockResolvedValue('network')
    mockPassword.mockResolvedValue('sekret')
    mockConfirm.mockResolvedValue(true)

    const restore = stubTerminal(true)
    try {
      await runSetup()
    } finally {
      restore()
    }

    expect(mockSelect).toHaveBeenCalledTimes(1)
    expect(await readJson('config.json')).toMatchObject({ server: { host: '0.0.0.0', https: true } })
    const auth = await readJson('auth.json')
    expect(auth['strategy']).toBe('network')
    expect(typeof auth['encryptedPassword']).toBe('string')
  })

  it('does not touch an already configured install', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(join(TEST_DIR, 'auth.json'), '{"strategy":"local","encryptedPassword":null}', 'utf-8')

    const restore = stubTerminal(true)
    try {
      await runSetup()
    } finally {
      restore()
    }

    expect(mockSelect).not.toHaveBeenCalled()
    await expect(access(join(TEST_DIR, 'config.json'))).rejects.toThrow()
  })
})

describe('isInteractiveStdin', () => {
  it('accepts a real terminal', async () => {
    const { isInteractiveStdin } = await import('./main.js')
    const terminal = { isTTY: true }
    expect(isInteractiveStdin({}, terminal, terminal)).toBe(true)
  })

  it('rejects piped stdio', async () => {
    const { isInteractiveStdin } = await import('./main.js')
    expect(isInteractiveStdin({}, { isTTY: undefined }, { isTTY: undefined })).toBe(false)
  })

  it('rejects a terminal that belongs to a watcher', async () => {
    const { isInteractiveStdin } = await import('./main.js')
    const terminal = { isTTY: true }
    expect(isInteractiveStdin({ MORRISCODE_NONINTERACTIVE: '1' }, terminal, terminal)).toBe(false)
  })
})

describe('hasSetupAnswerFlags', () => {
  it('ignores flags that do not answer the setup questions', async () => {
    const { hasSetupAnswerFlags } = await import('./main.js')
    expect(hasSetupAnswerFlags({})).toBe(false)
  })

  it.each<[string, FirstRunSetupFlags]>([
    ['network', { network: true }],
    ['host', { host: '0.0.0.0' }],
    ['https', { https: true }],
    ['no-https', { noHttps: true }],
    ['https-cert', { httpsCert: '/certs/server.crt' }],
    ['https-key', { httpsKey: '/certs/server.key' }],
    ['password', { password: 'sekret' }],
  ])('treats --%s as an answer', async (_name, flags) => {
    const { hasSetupAnswerFlags } = await import('./main.js')
    expect(hasSetupAnswerFlags(flags)).toBe(true)
  })
})
