import { parseArgs } from 'node:util'
import { select, password, isCancel, cancel } from '@clack/prompts'
import { generateKeyPairSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { cliT, setCliMode } from './i18n.js'
import { isLoopbackHost, networkAccessError } from '../shared/network-security.js'

export type Mode = 'production' | 'development' | 'test'

export function printHelp(): void {
  console.log(
    cliT({
      en: `
MorrisCode - Local LLM coding assistant

Usage:
  morriscode [command] [options]

Commands:
  (none)           Start server for current project
  config           Show current configuration
  provider add     Add a new LLM provider
  provider list    List configured providers
  provider use     Switch active provider
  provider remove  Remove a provider
  service          Manage the systemd service (install, start, stop, status, logs, uninstall)
  pwa              Manage the PWA installation (install, uninstall, launch, update, status)
  mcp              Print a paste-ready MCP client config for this server (asks for the password if set)
  install          Install a persistent MorrisCode launcher (use --check to inspect)
  update           Update MorrisCode to the latest version

Options:
  -p, --port <number>     Specify port (default: 10369 for prod, 10469 for dev)
  --network               Listen on 0.0.0.0 so other machines on the LAN can connect
  --host <address>        Bind address (default: 127.0.0.1)
  --https                 Serve over HTTPS with a self-signed certificate
  --no-https              Serve over plain HTTP
  --https-cert <path>     Certificate PEM to use instead of the generated one (needs --https-key)
  --https-key <path>      Private key PEM to use instead of the generated one (needs --https-cert)
  --no-browser            Don't open browser on start
  -h, --help              Show this help message
  -v, --version           Show version number
`,
      fr: `
MorrisCode - Assistant de codage LLM local

Utilisation :
  morriscode [commande] [options]

Commandes :
  (aucune)        Démarrer le serveur pour le projet courant
  config          Afficher la configuration actuelle
  provider add    Ajouter un nouveau fournisseur LLM
  provider list   Lister les fournisseurs configurés
  provider use    Changer de fournisseur actif
  provider remove Supprimer un fournisseur
  service         Gérer le service systemd (install, start, stop, status, logs, uninstall)
  pwa             Gérer l’installation PWA (install, uninstall, launch, update, status)
  mcp             Afficher une configuration MCP prête à coller pour ce serveur (demande le mot de passe s’il est défini)
  install         Installer un lanceur MorrisCode persistant (utiliser --check pour inspecter)
  update          Mettre MorrisCode à jour vers la dernière version

Options :
  -p, --port <nombre>    Spécifier le port (défaut : 10369 pour prod, 10469 pour dev)
  --network              Écouter sur 0.0.0.0 pour que les autres machines du réseau local puissent se connecter
  --host <adresse>       Adresse d’écoute (défaut : 127.0.0.1)
  --https                Servir en HTTPS avec un certificat auto-signé
  --no-https             Servir en HTTP simple
  --https-cert <chemin>  Certificat PEM à utiliser au lieu du certificat généré (nécessite --https-key)
  --https-key <chemin>   Clé privée PEM à utiliser au lieu de la clé générée (nécessite --https-cert)
  --no-browser           Ne pas ouvrir le navigateur au démarrage
  -h, --help             Afficher ce message d’aide
  -v, --version          Afficher le numéro de version
`,
    }),
  )
}

/** Values that force non-interactive mode, whatever stdio looks like. */
const NON_INTERACTIVE_VALUES = new Set(['1', 'true', 'yes'])

/** Flags that already answer the first-run questions, so prompting would only repeat them. */
export interface FirstRunSetupFlags {
  host?: string
  network?: boolean
  https?: boolean
  noHttps?: boolean
  httpsCert?: string
  httpsKey?: string
  password?: string
}

/**
 * True when the CLI can own the terminal and wait for an answer.
 *
 * `MORRISCODE_NONINTERACTIVE` is set by the dev script, which runs the CLI under `tsx watch`: the
 * watcher reads the same stdin and restarts the process on every keystroke, so a prompt there is
 * redrawn from scratch forever and its answer never reaches the config file.
 */
export function isInteractiveStdin(
  env: Record<string, string | undefined> = process.env,
  stdin: { isTTY?: boolean | undefined } = process.stdin,
  stdout: { isTTY?: boolean | undefined } = process.stdout,
): boolean {
  const forced = env['MORRISCODE_NONINTERACTIVE']
  if (forced !== undefined && NON_INTERACTIVE_VALUES.has(forced.toLowerCase())) {
    return false
  }
  return stdin.isTTY === true && stdout.isTTY === true
}

/** Whether the command line already answers the first-run questions. */
export function hasSetupAnswerFlags(flags: FirstRunSetupFlags): boolean {
  return (
    flags.network === true ||
    flags.host !== undefined ||
    flags.https === true ||
    flags.noHttps === true ||
    flags.httpsCert !== undefined ||
    flags.httpsKey !== undefined ||
    flags.password !== undefined
  )
}

/** Network access and custom certificates imply HTTPS; explicit HTTP is validated below. */
function resolveSetupHttps(flags: FirstRunSetupFlags): boolean {
  if (flags.noHttps === true) return false
  if (flags.https === true) return true
  return (
    flags.httpsCert !== undefined ||
    flags.httpsKey !== undefined ||
    !isLoopbackHost(flags.host ?? (flags.network === true ? '0.0.0.0' : '127.0.0.1'))
  )
}

/** Reports the configuration written without a prompt, and how to change it. */
function logNonInteractiveSetup(
  source: 'flags' | 'non-interactive',
  host: string,
  httpsEnabled: boolean,
  hasPassword: boolean,
): void {
  const access =
    host === '0.0.0.0'
      ? cliT({ en: 'local network', fr: 'réseau local' })
      : cliT({ en: 'localhost only', fr: 'localhost uniquement' })
  const reason =
    source === 'flags'
      ? cliT({ en: 'configured from the command line', fr: 'configuré depuis la ligne de commande' })
      : cliT({ en: 'no terminal to prompt on', fr: 'aucun terminal pour poser la question' })
  const https = httpsEnabled ? cliT({ en: 'enabled', fr: 'activé' }) : cliT({ en: 'disabled', fr: 'désactivé' })
  const pwd = hasPassword ? cliT({ en: 'set', fr: 'défini' }) : cliT({ en: 'none', fr: 'aucun' })

  console.log(
    cliT({ en: '\nMorrisCode Setup — ' + reason + '\n', fr: '\nConfiguration d’MorrisCode — ' + reason + '\n' }),
  )
  console.log(
    cliT({
      en: '  Access: ' + access + ', HTTPS: ' + https + ', password: ' + pwd,
      fr: '  Accès : ' + access + ', HTTPS : ' + https + ', mot de passe : ' + pwd,
    }),
  )
  console.log(
    cliT({
      en: '  Change it with --network/--host/--https/--password, or Settings → Advanced → Local network access.\n',
      fr: '  Modifiable avec --network/--host/--https/--password, ou Paramètres → Avancé → Accès réseau local.\n',
    }),
  )
}

export async function runNetworkSetup(mode: Mode, flags: FirstRunSetupFlags = {}): Promise<void> {
  const { loadAuthConfig, saveAuthConfig, encryptPassword } = await import('./auth.js')
  const { saveGlobalConfig } = await import('./config.js')
  const { getAuthKeyPath } = await import('./paths.js')

  const existingAuth = await loadAuthConfig(mode)
  if (existingAuth) {
    return
  }

  const fromFlags = hasSetupAnswerFlags(flags)
  const interactive = isInteractiveStdin() && !fromFlags

  let host = flags.host ?? (flags.network === true ? '0.0.0.0' : '127.0.0.1')
  let httpsEnabled = resolveSetupHttps(flags)
  let passwordValue = flags.password !== undefined && flags.password.length > 0 ? flags.password : undefined

  if (!interactive) {
    logNonInteractiveSetup(fromFlags ? 'flags' : 'non-interactive', host, httpsEnabled, passwordValue !== undefined)
  }

  const networkChoice = interactive
    ? await select({
        message: cliT({
          en: 'How should MorrisCode be accessible?',
          fr: 'Comment MorrisCode doit-il être accessible ?',
        }),
        options: [
          { value: 'localhost', label: cliT({ en: 'Secure (localhost only)', fr: 'Sécurisé (localhost uniquement)' }) },
          {
            value: 'network',
            label: cliT({ en: 'Accessible from local network', fr: 'Accessible depuis le réseau local' }),
          },
        ],
      })
    : undefined

  if (interactive && isCancel(networkChoice)) {
    cancel()
    process.exit(1)
  }

  const isNetwork = interactive && networkChoice === 'network'

  if (interactive) {
    host = isNetwork ? '0.0.0.0' : '127.0.0.1'
    httpsEnabled = isNetwork
  }

  if (isNetwork) {
    const pwd = await password({
      message: cliT({
        en: 'Set a password (required for network access; HTTPS is enabled automatically)',
        fr: 'Définissez un mot de passe (obligatoire pour l’accès réseau ; HTTPS est activé automatiquement)',
      }),
    })

    if (isCancel(pwd)) {
      cancel()
      process.exit(1)
    }

    passwordValue = typeof pwd === 'string' && pwd.length > 0 ? pwd : undefined
  }

  const safetyError = networkAccessError(host, httpsEnabled, passwordValue !== undefined)
  if (safetyError) throw new Error(cliT(safetyError))

  if (passwordValue && passwordValue.length > 0) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })

    const encryptedPassword = encryptPassword(passwordValue, publicKey)

    await saveAuthConfig(mode, {
      strategy: 'network',
      encryptedPassword,
    })

    const keyPath = getAuthKeyPath(mode)
    await writeFile(keyPath, privateKey, { mode: 0o600 })
  } else {
    await saveAuthConfig(mode, {
      strategy: host === '0.0.0.0' ? 'network' : 'local',
      encryptedPassword: null,
    })
  }

  await saveGlobalConfig(mode, {
    providers: [],
    server: {
      port: mode === 'development' ? 10469 : 10369,
      host,
      openBrowser: true,
      https: httpsEnabled,
      ...(flags.httpsCert !== undefined ? { httpsCert: flags.httpsCert } : {}),
      ...(flags.httpsKey !== undefined ? { httpsKey: flags.httpsKey } : {}),
    },
    logging: { level: 'error' },
    database: { path: '' },
    workspace: { workdir: process.cwd() },
    visionFallback: {
      enabled: false,
      url: 'http://localhost:11434',
      model: 'qwen3.5:0.8b',
      timeout: 120,
      backend: 'ollama' as const,
    },
  })

  console.log(cliT({ en: '✓ Configuration saved!\n', fr: '✓ Configuration enregistrée !\n' }))
}

export async function runConfig(mode: Mode): Promise<void> {
  const { loadGlobalConfig, getActiveProvider, getDefaultModel } = await import('./config.js')
  const { getGlobalConfigPath } = await import('./paths.js')

  const config = await loadGlobalConfig(mode)
  const configPath = getGlobalConfigPath(mode)
  const activeProvider = getActiveProvider(config)
  const defaultModel = getDefaultModel(config)

  console.log(cliT({ en: `Configuration (${mode}):`, fr: `Configuration (${mode}) :` }))
  console.log(cliT({ en: `  Location: ${configPath}`, fr: `  Emplacement : ${configPath}` }))
  console.log(
    cliT({ en: `  Providers: ${config.providers.length}`, fr: `  Fournisseurs : ${config.providers.length}` }),
  )
  if (activeProvider) {
    console.log(cliT({ en: `  Active: ${activeProvider.name}`, fr: `  Actif : ${activeProvider.name}` }))
    console.log(cliT({ en: `    URL: ${activeProvider.url}`, fr: `    URL : ${activeProvider.url}` }))
    console.log(cliT({ en: `    Model: ${defaultModel ?? 'auto'}`, fr: `    Modèle : ${defaultModel ?? 'auto'}` }))
    console.log(cliT({ en: `    Backend: ${activeProvider.backend}`, fr: `    Backend : ${activeProvider.backend}` }))
  } else {
    console.log(cliT({ en: `  Active: (none configured)`, fr: `  Actif : (aucun configuré)` }))
  }

  // Display server host with human-readable description
  const host = config.server.host ?? '127.0.0.1'
  const hostDisplay =
    host === '0.0.0.0'
      ? cliT({ en: `${host} (accessible from local network)`, fr: `${host} (accessible depuis le réseau local)` })
      : cliT({ en: `${host} (localhost only)`, fr: `${host} (localhost uniquement)` })
  console.log(cliT({ en: `  Server: ${hostDisplay}`, fr: `  Serveur : ${hostDisplay}` }))
  console.log(cliT({ en: `  Port: ${config.server.port}`, fr: `  Port : ${config.server.port}` }))

  const httpsEnabled = config.server.https === true
  console.log(
    cliT({
      en: `  HTTPS: ${httpsEnabled ? 'enabled (self-signed)' : 'disabled'}`,
      fr: `  HTTPS : ${httpsEnabled ? 'activé (auto-signé)' : 'désactivé'}`,
    }),
  )

  if (httpsEnabled) {
    const { describeCertificate } = await import('../server/tls.js')
    const certificate = describeCertificate({ server: config.server, mode })
    console.log(
      cliT({ en: `    Certificate: ${certificate.certPath}`, fr: `    Certificat : ${certificate.certPath}` }),
    )
  }
}

export async function runCli(options: { mode: Mode }): Promise<void> {
  const { mode } = options
  setCliMode(mode)

  const { values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      password: { type: 'string' },
      host: { type: 'string' },
      network: { type: 'boolean' },
      https: { type: 'boolean' },
      'no-https': { type: 'boolean' },
      'https-cert': { type: 'string' },
      'https-key': { type: 'string' },
      'no-browser': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      service: { type: 'boolean' },
      follow: { type: 'boolean', short: 'f' },
      check: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  const [command] = positionals

  if (values.version && !command) {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const packageJsonPath = join(__dirname, '../package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    console.log(packageJson.version)
    process.exit(0)
  }

  if (values.help && !command) {
    printHelp()
    process.exit(0)
  }

  switch (command) {
    case 'config': {
      await runConfig(mode)
      break
    }
    case 'provider': {
      const { runProviderCommand } = await import('./provider.js')
      const [, subcommand] = positionals
      await runProviderCommand(mode, subcommand)
      break
    }
    case 'service': {
      const { runServiceCommand } = await import('./service.js')
      const [, subcommand, ...serviceArgs] = positionals
      if (values.follow) {
        serviceArgs.push('-f')
      }
      if (subcommand === '--help' || subcommand === '-h' || values.help) {
        runServiceCommand(mode, undefined)
      } else {
        await runServiceCommand(mode, subcommand, ...serviceArgs)
      }
      break
    }
    case 'pwa': {
      const { runPwaCommand, printPwaHelp } = await import('./pwa.js')
      const [, subcommand] = positionals
      if (subcommand === '--help' || subcommand === '-h' || values.help) {
        printPwaHelp()
      } else {
        await runPwaCommand(mode, subcommand)
      }
      break
    }
    case 'mcp': {
      const { runMcpCommand } = await import('./mcp.js')
      const mcpOptions: { password?: string; port?: number } = {}
      if (values.password) mcpOptions.password = values.password
      if (values.port) mcpOptions.port = parseInt(values.port)
      await runMcpCommand(mode, mcpOptions)
      break
    }
    case 'install': {
      const { runInstall } = await import('./install.js')
      const code = await runInstall({ check: values.check === true })
      if (code !== 0) {
        process.exit(code)
      }
      break
    }
    case 'update': {
      const { runUpdate } = await import('./update.js')
      const code = await runUpdate()
      if (code !== 0) {
        process.exit(code)
      }
      break
    }

    default: {
      // The config is written once, on first install, by prompts only when a terminal can answer
      // them: flags win, and a watcher or a pipe means there is nobody to prompt.
      const { configFileExists } = await import('./config.js')
      const configExists = await configFileExists(mode)

      if (!configExists) {
        await runNetworkSetup(mode, {
          ...(values.host !== undefined ? { host: values.host } : {}),
          ...(values.network === true ? { network: true } : {}),
          ...(values.https === true ? { https: true } : {}),
          ...(values['no-https'] === true ? { noHttps: true } : {}),
          ...(values['https-cert'] !== undefined ? { httpsCert: values['https-cert'] } : {}),
          ...(values['https-key'] !== undefined ? { httpsKey: values['https-key'] } : {}),
          ...(values.password !== undefined ? { password: values.password } : {}),
        })
      }

      const { runServe } = await import('./serve.js')
      const serveOptions: {
        mode: Mode
        port?: number
        openBrowser?: boolean
        host?: string
        https?: boolean
        httpsCert?: string
        httpsKey?: string
      } = { mode }
      if (values.port) serveOptions.port = parseInt(values.port)
      if (values['no-browser'] === true) serveOptions.openBrowser = false

      // --network is sugar for listening on every interface; an explicit --host wins.
      const hostOverride = values.host ?? (values.network === true ? '0.0.0.0' : undefined)
      if (hostOverride !== undefined) serveOptions.host = hostOverride

      // Naming a certificate implies HTTPS, so a typo in the flag order can't silently serve plain HTTP.
      if (values['no-https'] === true) serveOptions.https = false
      else if (values.https === true) serveOptions.https = true
      else if (values['https-cert'] || values['https-key']) serveOptions.https = true
      if (values['https-cert']) serveOptions.httpsCert = values['https-cert']
      if (values['https-key']) serveOptions.httpsKey = values['https-key']

      await runServe(serveOptions)
    }
  }
}
