import type { PluginCapability } from '../../../shared/plugin.js'
import type { ProviderPluginRegistry } from '../../../provider/index.js'

/**
 * A provider plugin that ships inside MorrisCode instead of being installed into
 * `{configDir}/plugins`. The plugin host registers it at startup through the same
 * registry an external plugin uses, so presets, adapters and credentials behave
 * identically. An installed plugin that provides the same contributions wins.
 */
export interface BuiltInProviderPlugin {
  /** Plugin id, as listed in the plugins panel. */
  id: string
  version: string
  displayName: string
  description?: string
  author?: string
  capabilities: PluginCapability[]
  authAdapterIds: string[]
  transportAdapterIds: string[]
  presetIds: string[]
  /**
   * Installed plugin package names this built-in replaces. Those packages are not
   * loaded, so the maintained built-in is the one serving the provider. The package
   * stays on disk and is listed as disabled, with the reason.
   */
  supersedes?: string[]
  register(registry: ProviderPluginRegistry): Promise<void> | void
}
