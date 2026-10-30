/**
 * Skill System Types
 */

export interface SkillMetadata {
  id: string
  name: string
  description: string
  version: string
  group?: string
  estimatedTokens?: number
  [key: string]: unknown
}

export type SkillSource =
  'bundled' | 'global-shared' | 'global-morriscode' | 'selected' | 'project-shared' | 'project-morriscode' | 'plugin'

export interface SkillDefinition {
  metadata: SkillMetadata
  prompt: string
  rawMetadata?: Record<string, unknown>
  entrypoint?: string
  directory?: string
  source?: SkillSource
  legacy?: boolean
  warnings?: string[]
}
