import { z } from 'zod'
import type { ProviderResetCredits } from '../../../../../shared/types.js'

const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const summarySchema = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(z.unknown()).optional(),
})
const couponSchema = z.object({
  reset_type: z.literal('codex_rate_limits'),
  status: z.literal('available'),
  expires_at: z.unknown().optional(),
})

/** Display-only projection of the contract in openai/codex backend-client rate_limit_resets.rs. */
export function parseResetCredits(payload: unknown, now = Date.now()): ProviderResetCredits | undefined {
  const parsed = summarySchema.safeParse(payload)
  if (!parsed.success) return undefined
  const { available_count: availableCount, credits } = parsed.data
  if (!credits) return { availableCount }

  const coupons: NonNullable<ProviderResetCredits['coupons']> = []
  for (const row of credits) {
    const coupon = couponSchema.safeParse(row)
    if (!coupon.success) continue
    const rawExpiry = coupon.data.expires_at
    if (rawExpiry === null) {
      coupons.push({ expiresAt: null })
    } else {
      const expiresAt = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN
      if (Number.isFinite(expiresAt)) {
        if (expiresAt > now) coupons.push({ expiresAt: expiresAt / 1000 })
      } else {
        coupons.push({})
      }
    }
  }
  coupons.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
  return { availableCount, coupons }
}

/** No redemption operation exists here. Redirects cannot forward account credentials. */
export async function readResetCredits(
  headers: Record<string, string>,
  request: typeof fetch,
): Promise<ProviderResetCredits | undefined> {
  try {
    const response = await request(RESET_CREDITS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    return response.ok ? parseResetCredits(await response.json()) : undefined
  } catch {
    return undefined
  }
}
