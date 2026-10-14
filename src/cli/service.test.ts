import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { spawnSync, spawn } from 'node:child_process'
import { runServiceCommand, detectHeadless } from './service.js'

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  constants: { F_OK: 0 },
}))

const mockSpawnSync = vi.fn<(...args: Parameters<typeof spawnSync>) => ReturnType<typeof spawnSync>>()
const mockSpawn = vi.fn<(...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>>()

vi.mock('node:child_process', () => ({
  spawnSync: (...args: Parameters<typeof spawnSync>) => mockSpawnSync(...args),
  spawn: (...args: Parameters<typeof spawn>) => mockSpawn(...args),
}))

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('service on Windows', () => {
  afterEach(() => {
    setPlatform(realPlatform)
    process.exitCode = 0
  })

  it('prints a clear unsupported message and exits 1 without spawning anything', async () => {
    setPlatform('win32')
    const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runServiceCommand('production', 'status')

    expect(mockLog.mock.calls.flat().join('\n')).toContain('not supported on Windows')
    expect(process.exitCode).toBe(1)
    expect(mockSpawnSync).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    mockLog.mockRestore()
  })
})

describe('detectHeadless', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setPlatform('linux')
  })

  afterEach(() => {
    setPlatform(realPlatform)
    delete process.env['DISPLAY']
    delete process.env['WAYLAND_DISPLAY']
    delete process.env['XDG_RUNTIME_DIR']
  })

  it('returns false when DISPLAY is set', async () => {
    process.env['DISPLAY'] = ':0'
    await expect(detectHeadless()).resolves.toBe(false)
  })

  it('returns false when WAYLAND_DISPLAY is set', async () => {
    process.env['WAYLAND_DISPLAY'] = 'wayland-0'
    await expect(detectHeadless()).resolves.toBe(false)
  })

  it('returns true when no display env vars and no sockets', async () => {
    const { access } = vi.mocked(await import('node:fs/promises'))
    access.mockRejectedValue(new Error('not found'))
    await expect(detectHeadless()).resolves.toBe(true)
  })
})

describe('service install', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    setPlatform('linux')
    const { access, mkdir, writeFile } = vi.mocked(await import('node:fs/promises'))
    access.mockRejectedValue(new Error('not found'))
    mkdir.mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
    mockSpawnSync.mockReturnValue({
      stdout: '',
      stderr: '',
      status: 0,
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>)
    mockSpawn.mockReturnValue({
      on: vi.fn((event, cb) => {
        if (event === 'exit') cb(0)
        return undefined!
      }),
      stdout: null,
      stderr: null,
      pid: 999,
      stdin: null,
      connected: false,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    } as unknown as ReturnType<typeof spawn>)
    delete process.env['DISPLAY']
    delete process.env['WAYLAND_DISPLAY']
  })

  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('installs desktop-mode service by default when DISPLAY is set', async () => {
    process.env['DISPLAY'] = ':0'

    await runServiceCommand('production', 'install')

    const { writeFile } = vi.mocked(await import('node:fs/promises'))
    const calls = writeFile.mock.calls as [string, string, unknown][]

    const serviceCall = calls.find(([p]) => p.includes('morriscode.service'))
    expect(serviceCall).toBeDefined()
    expect(serviceCall![1]).toContain('graphical-session.target')
    expect(serviceCall![1]).toContain('Wants=graphical-session.target')

    const wrapperCall = calls.find(([p]) => p.includes('run.sh'))
    expect(wrapperCall).toBeDefined()
    expect(wrapperCall![1]).toContain('Xwayland')
  })

  it('installs headless-mode service when --headless flag given', async () => {
    await runServiceCommand('production', 'install', '--headless')

    const { writeFile } = vi.mocked(await import('node:fs/promises'))
    const calls = writeFile.mock.calls as [string, string, unknown][]

    const serviceCall = calls.find(([p]) => p.includes('morriscode.service'))
    expect(serviceCall).toBeDefined()
    expect(serviceCall![1]).toContain('default.target')
    expect(serviceCall![1]).not.toContain('graphical-session.target')
    expect(serviceCall![1]).not.toContain('Wants=')

    const wrapperCall = calls.find(([p]) => p.includes('run.sh'))
    expect(wrapperCall).toBeDefined()
    expect(wrapperCall![1]).not.toContain('Xwayland')
  })

  it('installs desktop-mode service when --desktop flag given in headless env', async () => {
    await runServiceCommand('production', 'install', '--desktop')

    const { writeFile } = vi.mocked(await import('node:fs/promises'))
    const calls = writeFile.mock.calls as [string, string, unknown][]

    const serviceCall = calls.find(([p]) => p.includes('morriscode.service'))
    expect(serviceCall).toBeDefined()
    expect(serviceCall![1]).toContain('graphical-session.target')
    expect(serviceCall![1]).toContain('Wants=graphical-session.target')
  })

  it('outputs hint about --headless when installing desktop mode', async () => {
    process.env['DISPLAY'] = ':0'
    const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runServiceCommand('production', 'install')

    const output = mockLog.mock.calls.flat().join('\n')
    expect(output).toContain('--headless')
    mockLog.mockRestore()
  })

  it('outputs confirmation when installing headless mode', async () => {
    const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runServiceCommand('production', 'install', '--headless')

    const output = mockLog.mock.calls.flat().join('\n')
    expect(output).toContain('headless')
    mockLog.mockRestore()
  })
})

describe('service logs', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // The systemd path under test is Unix-only; pin the platform so the suite
    // also runs on Windows dev machines (the win32 guard would short-circuit).
    setPlatform('linux')
    const { access } = vi.mocked(await import('node:fs/promises'))
    access.mockResolvedValue(undefined)
  })

  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('uses spawnSync when no follow flag given', async () => {
    mockSpawnSync.mockReturnValue({
      stdout: 'log line 1\nlog line 2\n',
      stderr: '',
      status: 0,
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>)

    await runServiceCommand('production', 'logs')

    expect(mockSpawnSync).toHaveBeenCalledWith('journalctl', ['--user', '-u', 'morriscode', '-n', '50', '--no-pager'], {
      encoding: 'utf-8',
      windowsHide: true,
    })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('uses spawn with -f when -f flag given', async () => {
    await runServiceCommand('production', 'logs', '-f')

    expect(mockSpawn).toHaveBeenCalledWith('journalctl', ['--user', '-u', 'morriscode', '-f', '--no-pager'], {
      stdio: 'inherit',
      windowsHide: true,
    })
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('uses spawn with -f when --follow flag given', async () => {
    await runServiceCommand('production', 'logs', '--follow')

    expect(mockSpawn).toHaveBeenCalledWith('journalctl', ['--user', '-u', 'morriscode', '-f', '--no-pager'], {
      stdio: 'inherit',
      windowsHide: true,
    })
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })
})
