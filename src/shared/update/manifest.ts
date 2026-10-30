import { z } from 'zod'

/** Platform names used by the release manifest. Keep them aligned with Node's process.platform. */
export const releasePlatformSchema = z.enum(['win32', 'linux'])
export const releaseArchSchema = z.enum(['x64', 'arm64'])

export const releaseAssetSchema = z.object({
  platform: releasePlatformSchema,
  arch: releaseArchSchema,
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  keyId: z.string().min(1),
  version: z.string().min(1),
  tag: z.string().min(1),
  commit: z.string().min(7),
  publishedAt: z.string().min(1),
  minNode: z.string().optional(),
  assets: z.array(releaseAssetSchema).min(1),
})

export type ReleasePlatform = z.infer<typeof releasePlatformSchema>
export type ReleaseArch = z.infer<typeof releaseArchSchema>
export type ReleaseAsset = z.infer<typeof releaseAssetSchema>
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>

export function parseReleaseManifest(text: string): ReleaseManifest {
  return releaseManifestSchema.parse(JSON.parse(text))
}

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

/** Parse a semver-like version, tolerating a leading v and build metadata. */
export function parseVersion(value: string): ParsedVersion | null {
  const withoutPrefix = value.trim().replace(/^v/i, '')
  const withoutBuild = withoutPrefix.split('+')[0] ?? ''
  const dashIndex = withoutBuild.indexOf('-')
  const core = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)
  const prereleaseText = dashIndex === -1 ? '' : withoutBuild.slice(dashIndex + 1)
  const parts = core.split('.')
  if (parts.length !== 3) return null
  const numbers = parts.map((part) => Number(part))
  if (numbers.some((number) => !Number.isInteger(number) || number < 0)) return null
  return {
    major: numbers[0] ?? 0,
    minor: numbers[1] ?? 0,
    patch: numbers[2] ?? 0,
    prerelease: prereleaseText ? prereleaseText.split('.') : [],
  }
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b))
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** Compare two versions. Returns -1, 0 or 1; unparsable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const result = comparePrereleaseIdentifiers(leftPart, rightPart)
    if (result !== 0) return result
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function isStableVersion(value: string): boolean {
  const parsed = parseVersion(value)
  return Boolean(parsed && parsed.prerelease.length === 0)
}

export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

export function assetForPlatform(
  manifest: ReleaseManifest,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | undefined {
  if (platform !== 'win32' && platform !== 'linux') return undefined
  if (arch !== 'x64' && arch !== 'arm64') return undefined
  return manifest.assets.find((asset) => asset.platform === platform && asset.arch === arch)
}
