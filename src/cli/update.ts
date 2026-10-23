import { spawnSync } from 'node:child_process'
import { VERSION } from '../constants.js'
import { cliT } from './i18n.js'

/**
 * Run npm with fixed args. On Windows npm is npm.cmd, which Node refuses to
 * spawn directly (CVE-2024-27980), so go through the shell — as a single
 * command string to avoid DEP0190 (args are fixed literals, no injection).
 */
function npm(args: string[], inherit = false): { ok: boolean; stdout: string } {
  const win = process.platform === 'win32'
  const result = spawnSync(win ? ['npm', ...args].join(' ') : 'npm', win ? [] : args, {
    encoding: 'utf-8',
    ...(inherit ? { stdio: 'inherit' as const } : {}),
    shell: win,
    windowsHide: true,
  })
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() }
}

export async function runUpdate(options: { refreshLauncher?: () => Promise<number> } = {}): Promise<number> {
  const releaseInstall =
    process.env['MORRISCODE_INSTALL_FLAVOR'] === 'release' ||
    /[\\/]releases[\\/][^\\/]+[\\/]dist[\\/]/.test(process.argv[1] ?? '')
  if (releaseInstall) {
    console.log(
      cliT({
        en: 'This installation is updated from signed GitHub releases. Use the update button in the MorrisCode app.',
        fr: 'Cette installation se met à jour depuis les releases GitHub signées. Utilisez le bouton de mise à jour dans l’application MorrisCode.',
      }),
    )
    return 0
  }

  const view = npm(['view', 'morriscode', 'version'])
  if (!view.ok) {
    console.error(
      cliT({
        en: 'Failed to check the latest version (npm view morriscode version)',
        fr: 'Échec de la vérification de la dernière version (npm view morriscode version)',
      }),
    )
    return 1
  }
  const latest = view.stdout

  if (VERSION === latest) {
    console.log(
      cliT({
        en: `MorrisCode is already at the latest version: ${VERSION}`,
        fr: `MorrisCode est déjà à la dernière version : ${VERSION}`,
      }),
    )
    return 0
  }

  console.log(
    cliT({
      en: `Updating MorrisCode: ${VERSION} -> ${latest}`,
      fr: `Mise à jour d’MorrisCode : ${VERSION} -> ${latest}`,
    }),
  )
  if (!npm(['install', '-g', 'morriscode@latest'], true).ok) {
    return 1
  }
  const refreshLauncher =
    options.refreshLauncher ??
    (async () => {
      const { runInstall } = await import('./install.js')
      return runInstall({ quiet: true })
    })
  const installCode = await refreshLauncher()
  if (installCode !== 0) {
    console.error(
      cliT({
        en: 'MorrisCode updated, but the persistent launcher could not be refreshed.',
        fr: 'MorrisCode a été mis à jour, mais le lanceur persistant n’a pas pu être actualisé.',
      }),
    )
    return installCode
  }
  console.log(cliT({ en: `Updated: ${latest}`, fr: `Mis à jour : ${latest}` }))
  console.log(
    cliT({
      en: 'Please restart MorrisCode to use the new version.',
      fr: 'Veuillez redémarrer MorrisCode pour utiliser la nouvelle version.',
    }),
  )
  return 0
}
