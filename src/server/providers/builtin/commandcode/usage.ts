import { asRecord, toNumber } from '../usage-values.js'
import type { Provider } from '../../../../shared/types.js'
import type { ProviderUsage, ProviderUsageWindow } from '../../../../provider/index.js'
import { logger } from '../../../utils/logger.js'

/**
 * Command Code usage, read the way its own client does: `alpha/whoami` for the org id,
 * then `alpha/billing/credits` for the two rolling windows. The API key never leaves
 * that exact host.
 */
const COMMAND_CODE_HOST = 'api.commandcode.ai'
const REQUEST_TIMEOUT_MS = 15_000
const FIVE_HOUR_MINUTES = 300
const WEEKLY_MINUTES = 10080

export function isCommandCodeProvider(provider: Provider): boolean {
  try {
    return new URL(provider.url).host === COMMAND_CODE_HOST
  } catch {
    return false
  }
}

/** `{ cap, used, resetAt }` as the backend reports a rolling window. */
function windowFrom(value: unknown): { usedPercent: number; resetsAt?: number } | undefined {
  const row = asRecord(value)
  if (!row) return undefined
  const cap = toNumber(row['cap'])
  const used = toNumber(row['used'])
  if (cap === undefined || used === undefined || cap <= 0 || used < 0) return undefined
  const resetsAt =
    toNumber(row['resetAt']) ?? toNumber(row['resetsAt']) ?? toNumber(row['reset_at']) ?? toNumber(row['resets_at'])
  return { usedPercent: (used / cap) * 100, ...(resetsAt !== undefined && { resetsAt }) }
}

async function fetchOrgId(
  url: string,
  headers: Record<string, string>,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await request(url, { headers, signal, redirect: 'error' })
    if (!response.ok) return undefined
    const body = asRecord(await response.json())
    const data = asRecord(body?.['data']) ?? body
    const orgId = asRecord(data?.['org'])?.['id']
    return typeof orgId === 'string' && orgId.trim() !== '' ? orgId.trim() : undefined
  } catch {
    return undefined
  }
}

export async function fetchCommandCodeUsage(
  provider: Provider,
  request: typeof fetch = fetch,
): Promise<ProviderUsage | undefined> {
  const apiKey = provider.apiKey?.trim()
  if (!apiKey || !isCommandCodeProvider(provider)) return undefined

  const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const base = `https://${COMMAND_CODE_HOST}`
  const orgId = await fetchOrgId(`${base}/alpha/whoami`, headers, request, signal)
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''

  const response = await request(`${base}/alpha/billing/credits${query}`, { headers, signal, redirect: 'error' })
  if (!response.ok) return undefined

  const body = asRecord(await response.json())
  const data = asRecord(body?.['data']) ?? body
  const limits = asRecord(data?.['windowLimits'])
  const fiveHour = windowFrom(limits?.['fiveHour'])
  const weekly = windowFrom(limits?.['weekly'])
  const windows: ProviderUsageWindow[] = [
    ...(fiveHour ? [{ ...fiveHour, windowMinutes: FIVE_HOUR_MINUTES }] : []),
    ...(weekly ? [{ ...weekly, windowMinutes: WEEKLY_MINUTES }] : []),
  ]
  if (windows.length === 0) {
    // The endpoint is undocumented: name the fields that arrived (never their values) so
    // a changed shape can be corrected from the log instead of guessed at.
    logger.warn('Command Code usage reported no recognizable window', {
      fields: Object.keys(data ?? {}).join(','),
      windowFields: limits ? Object.keys(limits).join(',') : 'none',
    })
    return undefined
  }

  return { windows, observedAt: Date.now() }
}
