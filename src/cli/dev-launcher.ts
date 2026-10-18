import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { select, isCancel } from '@clack/prompts'
import { isInteractiveStdin } from './main.js'
import { cliT, setCliMode } from './i18n.js'
import { findDevPort } from './dev-port.js'

/** Ask before tsx watch takes ownership of stdin. The choice applies to this run only. */
export async function startDevWatcher(args: string[]): Promise<number> {
  setCliMode('development')
  const hasHost = args.some((arg) => arg === '--network' || arg === '--host' || arg.startsWith('--host='))
  const isCommand = args.some((arg) =>
    ['--help', '-h', '--version', '-v', 'config', 'provider', 'service', 'pwa', 'mcp', 'install', 'update'].includes(
      arg,
    ),
  )
  const launchArgs = [...args]
  if (isInteractiveStdin() && !hasHost && !isCommand) {
    const host = await select({
      message: cliT({ en: 'How should MorrisCode be accessible?', fr: 'Comment MorrisCode doit-il être accessible ?' }),
      options: [
        { value: '127.0.0.1', label: cliT({ en: 'Secure (localhost only)', fr: 'Sécurisé (localhost uniquement)' }) },
        {
          value: '0.0.0.0',
          label: cliT({
            en: 'Accessible from local network (phone, other devices)',
            fr: 'Accessible depuis le réseau local (téléphone, autres appareils)',
          }),
        },
      ],
    })
    if (isCancel(host)) return 1
    launchArgs.push('--host', host)
  }

  const hasPort = args.some((arg) => arg === '--port' || arg.startsWith('--port=') || /^-p/.test(arg))
  if (!isCommand && !hasPort && !process.env['MORRISCODE_PORT']) {
    const port = await findDevPort(10380)
    launchArgs.push('--port', String(port))
    console.log(cliT({ en: `Development port: ${port}`, fr: `Port de développement : ${port}` }))
  }

  const require = createRequire(import.meta.url)
  const result = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), 'watch', 'src/cli/dev.ts', '--no-browser', ...launchArgs],
    {
      stdio: 'inherit',
      env: { ...process.env, MORRISCODE_DEV: 'true', MORRISCODE_NONINTERACTIVE: '1' },
      windowsHide: true,
    },
  )
  if (result.error) throw result.error
  return result.status ?? 1
}
