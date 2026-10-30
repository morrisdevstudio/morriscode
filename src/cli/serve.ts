import { createServer } from '../server/index.js'
import { loadConfig } from '../server/config.js'
import { logger } from '../server/utils/logger.js'
import { displayStartupBanner, serverScheme } from '../server/utils/network.js'
import { describeCertificate } from '../server/tls.js'
import { detectProviderDefaultsFromUrl } from '../server/llm/backend.js'
import { loadGlobalConfig, getActiveProvider, getDefaultModel } from './config.js'
import { getDatabasePath, getGlobalConfigPath, ensureDataDirExists } from './paths.js'
import open from 'open'
import type { Mode } from './main.js'
import type { LlmBackend } from '../shared/types.js'
import { isLoopbackHost } from '../shared/network-security.js'

export interface ServeOptions {
  mode: Mode
  port?: number
  openBrowser?: boolean
  /** CLI override for server.host — wins over env and the global config. */
  host?: string
  /** CLI override for server.https — wins over env and the global config. */
  https?: boolean
  httpsCert?: string
  httpsKey?: string
}

export async function runServe(options: ServeOptions): Promise<void> {
  const { mode, port, openBrowser, host, https, httpsCert, httpsKey } = options

  // Ensure data directory exists before starting server
  await ensureDataDirExists(mode)

  const globalConfig = await loadGlobalConfig(mode)
  const activeProvider = getActiveProvider(globalConfig)
  const env = loadConfig()

  // Environment variables take precedence over global config file
  // This allows CLI overrides and e2e test configuration to work properly
  const envBackend = env.llm.backend
  const envModel = env.llm.model
  const envUrl = env.llm.baseUrl

  // Only use env values if they're not the defaults (meaning they were explicitly set)
  const isEnvBackendExplicit = envBackend !== 'unknown'
  const isEnvModelExplicit = !!envModel // empty default means not explicitly set
  const isEnvUrlExplicit = envUrl !== 'http://localhost:8000/v1' // default in config.ts
  const isEnvTimeoutExplicit = env.llm.timeout !== 300_000
  const isEnvIdleTimeoutExplicit = env.llm.idleTimeout !== 300_000

  // Get provider values with fallbacks
  const providerUrl = activeProvider?.url ?? envUrl
  const defaultModel = getDefaultModel(globalConfig) ?? envModel
  const providerBackend = (activeProvider?.backend ?? envBackend) as LlmBackend
  // The active provider's reasoning echo field: explicit config first, then the
  // URL-derived default (e.g. reasoning_content for the DeepSeek API).
  const envThinkingField = env.llm.thinkingField
  const providerThinkingField =
    activeProvider?.thinkingField ?? detectProviderDefaultsFromUrl(activeProvider?.url ?? '')?.thinkingField

  // TLS material precedence: CLI flag > env > global config.
  const resolvedHttpsCert = httpsCert ?? env.server.httpsCert ?? globalConfig.server.httpsCert
  const resolvedHttpsKey = httpsKey ?? env.server.httpsKey ?? globalConfig.server.httpsKey
  const resolvedHost = host ?? env.server.host ?? globalConfig.server.host ?? '127.0.0.1'

  const merged = {
    ...env,
    llm: {
      ...env.llm,
      baseUrl: isEnvUrlExplicit ? envUrl : providerUrl,
      model: isEnvModelExplicit ? envModel : defaultModel,
      backend: isEnvBackendExplicit ? envBackend : providerBackend,
      timeout: isEnvTimeoutExplicit ? env.llm.timeout : (globalConfig.llm?.timeout ?? env.llm.timeout),
      idleTimeout: isEnvIdleTimeoutExplicit
        ? env.llm.idleTimeout
        : (globalConfig.llm?.idleTimeout ?? env.llm.idleTimeout),
      ...(envThinkingField !== undefined
        ? { thinkingField: envThinkingField }
        : providerThinkingField
          ? { thinkingField: providerThinkingField }
          : {}),
    },
    server: {
      ...env.server,
      port: port ?? env.server.port,
      host: resolvedHost,
      openBrowser: openBrowser ?? globalConfig.server.openBrowser,
      https:
        https ?? (!isLoopbackHost(resolvedHost) || env.server.https === true || globalConfig.server.https === true),
      ...(resolvedHttpsCert !== undefined ? { httpsCert: resolvedHttpsCert } : {}),
      ...(resolvedHttpsKey !== undefined ? { httpsKey: resolvedHttpsKey } : {}),
    },
    database: {
      // Use env MORRISCODE_DB_PATH if explicitly set (e.g., ":memory:" for tests), otherwise use standard path
      path: env.database.path !== './morriscode.db' ? env.database.path : getDatabasePath(mode),
    },
    logging: {
      level: globalConfig.logging?.level ?? ('error' as const),
    },
    mode,
    // Pass providers for the server to use
    providers: globalConfig.providers,
    activeProviderId: globalConfig.activeProviderId,
    activeWorkflowId: globalConfig.activeWorkflowId,
    defaultModelSelection: globalConfig.defaultModelSelection,
    mcpServers: globalConfig.mcpServers as
      | Record<
          string,
          {
            transport: 'stdio' | 'http'
            command?: string
            args?: string[]
            env?: Record<string, string>
            url?: string
            disabledTools?: string[]
          }
        >
      | undefined,
    // Workdir precedence: .env override → global config → process.cwd()
    // Normalize: remove trailing slash to prevent double slashes in paths
    workdir: (process.env['MORRISCODE_WORKDIR'] ?? globalConfig.workspace?.workdir ?? process.cwd()).replace(/\/$/, ''),
    ...((env.disableAutoSessionTitle ?? globalConfig.disableAutoSessionTitle) !== undefined
      ? { disableAutoSessionTitle: env.disableAutoSessionTitle ?? globalConfig.disableAutoSessionTitle }
      : {}),
  }

  await createServer(merged)

  // Display startup banner
  displayStartupBanner({
    host: merged.server.host,
    port: merged.server.port,
    databasePath: merged.database.path,
    configPath: getGlobalConfigPath(mode),
    https: merged.server.https === true,
    certificate: describeCertificate(merged),
  })

  if (merged.server.openBrowser) {
    const browserHost = merged.server.host === '127.0.0.1' ? 'localhost' : merged.server.host
    const scheme = serverScheme(merged.server.https === true)
    open(`${scheme}://${browserHost}:${merged.server.port}`).catch(() => {
      logger.warn('Could not open browser automatically')
    })
  }
}
