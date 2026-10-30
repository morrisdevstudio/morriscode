export interface MorrisCodeMcpBootstrapInput {
  host: string
  port: number
  /** The endpoint speaks TLS when the server serves HTTPS. */
  https?: boolean
  authRequired: boolean
  sessionToken: string | null
}

export interface MorrisCodeMcpBootstrapConfig {
  name: string
  transport: 'http'
  url: string
  headers?: Record<string, string>
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*'])

function normalizeHost(host: string): string {
  return WILDCARD_HOSTS.has(host) ? '127.0.0.1' : host
}

export function buildMorrisCodeMcpBootstrap(input: MorrisCodeMcpBootstrapInput): MorrisCodeMcpBootstrapConfig {
  if (input.authRequired && !input.sessionToken) {
    throw new Error('Session token could not be computed — cannot bootstrap an authenticated MCP endpoint')
  }

  const config: MorrisCodeMcpBootstrapConfig = {
    name: 'morriscode',
    transport: 'http',
    url: `${input.https === true ? 'https' : 'http'}://${normalizeHost(input.host)}:${input.port}/mcp`,
  }
  if (input.authRequired && input.sessionToken) {
    config.headers = { Authorization: `Bearer ${input.sessionToken}` }
  }
  return config
}
