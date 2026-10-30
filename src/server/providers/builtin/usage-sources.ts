import type { Provider } from '../../../shared/types.js'
import type { ProviderUsage } from '../../../provider/index.js'
import { fetchCommandCodeUsage, isCommandCodeProvider } from './commandcode/usage.js'

/**
 * A provider whose usage MorrisCode knows how to read without a transport adapter,
 * matched by the provider's own endpoint rather than its display name.
 */
export interface BuiltInUsageSource {
  id: string
  matches(provider: Provider): boolean
  getUsage(provider: Provider): Promise<ProviderUsage | undefined>
}

export const BUILT_IN_USAGE_SOURCES: BuiltInUsageSource[] = [
  {
    id: 'command-code',
    matches: isCommandCodeProvider,
    getUsage: (provider) => fetchCommandCodeUsage(provider),
  },
]

export function findBuiltInUsageSource(provider: Provider): BuiltInUsageSource | undefined {
  return BUILT_IN_USAGE_SOURCES.find((source) => source.matches(provider))
}
