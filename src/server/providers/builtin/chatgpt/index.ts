/**
 * ChatGPT Plus / Pro provider, shipped inside MorrisCode.
 *
 * Ported from openfox-chatgpt (https://github.com/arthurlacoste/openfox-chatgpt),
 * MIT (c) 2026 Arthur Lacoste — see LICENSE in this directory.
 */
import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from '../../../../provider/index.js'
import type { BuiltInProviderPlugin } from '../types.js'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { OpenAIBrowserAuthAdapter } from './auth/openai-browser-auth.js'
import { CodexTransportAdapter } from './transport/codex.js'

export const chatGPTPreset: ProviderPreset = {
  id: 'chatgpt',
  name: 'ChatGPT Plus / Pro',
  description: 'Use a ChatGPT account through the Codex transport.',
  requiresAuth: true,
  authAdapter: 'openai-account',
  transportAdapter: 'openai-codex',
  defaults: {
    name: 'ChatGPT Plus / Pro',
    url: 'https://chatgpt.com/backend-api/codex',
    backend: 'openai',
  },
  connectLabel: 'Connect ChatGPT',
  disconnectLabel: 'Disconnect',
  missingPluginMessage: 'This provider ships with MorrisCode. Restart MorrisCode to load it again.',
}

export async function register(registry: ProviderPluginRegistry): Promise<void> {
  const storageDirectory = join(registry.runtime.configDirectory, 'credentials', 'chatgpt')
  const credentials = new FileProviderCredentialStore(
    join(storageDirectory, 'credentials.json'),
    join(storageDirectory, 'credentials.key'),
  )
  const auth = new OpenAIBrowserAuthAdapter(credentials)
  registry.registerAuth(auth)
  registry.registerTransport(new CodexTransportAdapter(auth))
  registry.registerPreset(chatGPTPreset)
}

/** Descriptor the plugin host uses to load this provider without an installed package. */
export const CHATGPT_BUILTIN: BuiltInProviderPlugin = {
  id: 'morriscode-chatgpt',
  version: '1.0.0',
  displayName: 'ChatGPT Plus / Pro',
  description: 'Use a ChatGPT Plus or Pro subscription as a provider, without an API key.',
  author: 'MorrisCode (ported from openfox-chatgpt by Arthur Lacoste)',
  capabilities: ['providers', 'models'],
  authAdapterIds: ['openai-account'],
  transportAdapterIds: ['openai-codex'],
  presetIds: ['chatgpt'],
  // The upstream plugin freezes the catalog at the gpt-5 generation; MorrisCode ships
  // the maintained version, so an installed copy is left out. See NOTICE.md.
  supersedes: ['openfox-chatgpt'],
  register,
}
