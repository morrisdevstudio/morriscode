import { describe, expect, it, vi } from 'vitest'
import { parseResetCredits, readResetCredits } from './reset-credits.js'

describe('ChatGPT reset coupon display', () => {
  it('keeps only available, unexpired coupons and strips account and credit identifiers', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    const result = parseResetCredits(
      {
        available_count: 3,
        credits: [
          {
            id: 'private-credit',
            profile_user_id: 'private-user',
            reset_type: 'codex_rate_limits',
            status: 'available',
            expires_at: '2026-10-29T12:00:00Z',
          },
          { reset_type: 'codex_rate_limits', status: 'available', expires_at: '2026-10-22T12:00:00Z' },
          { reset_type: 'codex_rate_limits', status: 'available', expires_at: null },
          { reset_type: 'codex_rate_limits', status: 'redeemed', expires_at: '2026-10-30T12:00:00Z' },
          { reset_type: 'codex_rate_limits', status: 'available', expires_at: '2026-10-15T12:00:00Z' },
        ],
      },
      now,
    )
    expect(result).toEqual({
      availableCount: 3,
      coupons: [
        { expiresAt: Date.parse('2026-10-22T12:00:00Z') / 1000 },
        { expiresAt: Date.parse('2026-10-29T12:00:00Z') / 1000 },
        { expiresAt: null },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('distinguishes missing details from a known empty list', () => {
    expect(parseResetCredits({ available_count: 2 })).toEqual({ availableCount: 2 })
    expect(parseResetCredits({ available_count: 0, credits: [] })).toEqual({ availableCount: 0, coupons: [] })
    expect(parseResetCredits({})).toBeUndefined()
    expect(parseResetCredits({ available_count: -1 })).toBeUndefined()
  })

  it('does not invent expiry dates or display unknown coupon types', () => {
    expect(
      parseResetCredits({
        available_count: 2,
        credits: [
          { reset_type: 'codex_rate_limits', status: 'available', expires_at: 'invalid' },
          { reset_type: 'future', status: 'available', expires_at: null },
        ],
      }),
    ).toEqual({ availableCount: 2, coupons: [{}] })
  })

  it('only performs a GET to the fixed OpenAI host and refuses redirects', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available_count: 0, credits: [] })))
    await readResetCredits({ Authorization: 'Bearer test' }, request)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    )
  })

  it('returns unavailable on refusal or network errors', async () => {
    expect(await readResetCredits({}, vi.fn().mockResolvedValue(new Response('', { status: 403 })))).toBeUndefined()
    expect(await readResetCredits({}, vi.fn().mockRejectedValue(new Error('network')))).toBeUndefined()
  })
})
