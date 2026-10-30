import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ select: vi.fn(), spawn: vi.fn(), interactive: vi.fn(), port: vi.fn() }))
vi.mock('./dev-port.js', () => ({ findDevPort: mocks.port }))
vi.mock('@clack/prompts', () => ({ select: mocks.select, isCancel: (value: unknown) => typeof value === 'symbol' }))
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }))
vi.mock('./main.js', () => ({ isInteractiveStdin: mocks.interactive }))
vi.mock('./i18n.js', () => ({ setCliMode: vi.fn(), cliT: (value: { en: string }) => value.en }))

import { startDevWatcher } from './dev-launcher.js'

describe('development launcher', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.interactive.mockReturnValue(true)
    mocks.spawn.mockReturnValue({ status: 0 })
    mocks.port.mockResolvedValue(10380)
    vi.stubEnv('MORRISCODE_PORT', '')
  })

  it('checks ports from 10380 and forwards the available port to the server', async () => {
    mocks.interactive.mockReturnValue(false)
    mocks.port.mockResolvedValue(10382)
    await startDevWatcher([])
    expect(mocks.port).toHaveBeenCalledWith(10380)
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--port', '10382']))
  })

  it.each([['--port', '10400'], ['-p', '10401'], ['--port=10402'], ['-p10403']])(
    'respects explicit port arguments %j',
    async (...args) => {
      mocks.interactive.mockReturnValue(false)
      await startDevWatcher(args)
      expect(mocks.port).not.toHaveBeenCalled()
      expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(args))
    },
  )

  it('respects the port supplied by a dev-server manager', async () => {
    vi.stubEnv('MORRISCODE_PORT', '10410')
    mocks.interactive.mockReturnValue(false)
    await startDevWatcher([])
    expect(mocks.port).not.toHaveBeenCalled()
    expect(mocks.spawn.mock.calls[0]?.[2].env.MORRISCODE_PORT).toBe('10410')
  })

  it.each(['127.0.0.1', '0.0.0.0'])('selects %s before starting the watcher', async (host) => {
    mocks.select.mockImplementation(async () => {
      expect(mocks.spawn).not.toHaveBeenCalled()
      return host
    })
    expect(await startDevWatcher([])).toBe(0)
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['watch', 'src/cli/dev.ts', '--host', host]),
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ MORRISCODE_DEV: 'true', MORRISCODE_NONINTERACTIVE: '1' }),
      }),
    )
  })

  it('asks again on subsequent launches, even with an existing configuration', async () => {
    mocks.select.mockResolvedValueOnce('0.0.0.0').mockResolvedValueOnce('127.0.0.1')
    await startDevWatcher([])
    await startDevWatcher([])
    expect(mocks.select).toHaveBeenCalledTimes(2)
    expect(mocks.spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--host', '127.0.0.1']))
  })

  it.each([['--network'], ['--host', '127.0.0.1'], ['--host=0.0.0.0'], ['--help'], ['config']])(
    'preserves explicit CLI arguments %j without prompting',
    async (...args) => {
      await startDevWatcher(args)
      expect(mocks.select).not.toHaveBeenCalled()
      expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(args))
    },
  )

  it('does not prompt when launched without an interactive terminal', async () => {
    mocks.interactive.mockReturnValue(false)
    await startDevWatcher([])
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('cancels without starting the watcher', async () => {
    mocks.select.mockResolvedValue(Symbol('cancel'))
    expect(await startDevWatcher([])).toBe(1)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
