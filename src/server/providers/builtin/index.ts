import { CHATGPT_BUILTIN } from './chatgpt/index.js'
import type { BuiltInProviderPlugin } from './types.js'

export type { BuiltInProviderPlugin }

/** Provider plugins compiled into MorrisCode — nothing to install. */
export const BUILT_IN_PROVIDER_PLUGINS: BuiltInProviderPlugin[] = [CHATGPT_BUILTIN]

export function findBuiltInProviderPlugin(id: string): BuiltInProviderPlugin | undefined {
  return BUILT_IN_PROVIDER_PLUGINS.find((plugin) => plugin.id === id)
}

export function isBuiltInProviderPluginId(id: string): boolean {
  return findBuiltInProviderPlugin(id) !== undefined
}

/** Package names of installed plugins the built-ins replace. */
export function builtInSupersededPluginIds(): Set<string> {
  return new Set(BUILT_IN_PROVIDER_PLUGINS.flatMap((plugin) => plugin.supersedes ?? []))
}
