// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { useLocaleStore } from '../../stores/locale'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProviderUsage } from '../../hooks/useProviderUsage'
import { ProviderUsageIndicator } from './ProviderUsageIndicator'

vi.mock('../../hooks/useProviderUsage', () => ({ useProviderUsage: vi.fn() }))

const usage = vi.mocked(useProviderUsage)

function report(usageData: unknown): void {
  usage.mockReturnValue({ data: usageData, loading: false, refresh: vi.fn() } as never)
}

function show(): ReturnType<typeof render> {
  return render(<ProviderUsageIndicator providerId="chatgpt" />)
}

describe('ProviderUsageIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLocaleStore.getState().applyLocale('en')
  })

  it('shows nothing when the selected provider does not meter usage', () => {
    report({ usage: null })

    const { container } = show()

    expect(container.firstChild).toBeNull()
  })

  it('shows the short slot and the weekly window with their percentages', () => {
    report({
      usage: {
        windows: [
          { usedPercent: 42, windowMinutes: 300, resetsAt: 1792158000 },
          { usedPercent: 18, windowMinutes: 10080 },
        ],
      },
    })

    show()

    expect(screen.getByTestId('provider-usage-window-0').textContent).toMatch(/5\s?h\s*42/)
    expect(screen.getByTestId('provider-usage-window-1').textContent).toMatch(/7\s?(j|d)\s*18/)
  })

  it('warns once a window passes the threshold', () => {
    report({ usage: { windows: [{ usedPercent: 91, windowMinutes: 300 }] } })

    show()

    expect(screen.getByTestId('provider-usage-window-0').className).toContain('text-accent-warning')
  })

  it('stays muted below the threshold', () => {
    report({ usage: { windows: [{ usedPercent: 12, windowMinutes: 300 }] } })

    show()

    expect(screen.getByTestId('provider-usage-window-0').className).toContain('text-text-muted')
  })

  it('still shows a percentage the backend sent without a window length', () => {
    report({ usage: { windows: [{ usedPercent: 7 }] } })

    show()

    expect(screen.getByTestId('provider-usage-window-0').textContent).toMatch(/7/)
  })

  it('opens a read-only coupon list with complete expiry dates and no redeem button', () => {
    report({
      usage: {
        windows: [],
        resetCredits: {
          availableCount: 2,
          coupons: [{ expiresAt: Date.parse('2027-10-22T18:28:00Z') / 1000 }, { expiresAt: null }],
        },
      },
    })
    show()
    fireEvent.click(screen.getByRole('button', { name: '2 reset coupons' }))
    expect(screen.getByRole('dialog').textContent).toContain('2027')
    expect(screen.getByText('No expiration date')).toBeTruthy()
    expect(screen.getByText(/Use your coupons in ChatGPT/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /redeem|use.*reset/i })).toBeNull()
  })

  it('distinguishes unknown availability from zero coupons and missing details', () => {
    report({ usage: { windows: [], resetCredits: { availableCount: null } } })
    const view = show()
    expect(screen.getByRole('button', { name: 'Reset coupons unavailable' })).toBeTruthy()
    report({ usage: { windows: [], resetCredits: { availableCount: 0, coupons: [] } } })
    view.rerender(<ProviderUsageIndicator providerId="chatgpt" />)
    fireEvent.click(screen.getByRole('button', { name: '0 reset coupons' }))
    expect(screen.getByText('No reset coupons available.')).toBeTruthy()
    report({ usage: { windows: [], resetCredits: { availableCount: 3 } } })
    view.rerender(<ProviderUsageIndicator providerId="chatgpt" />)
    expect(screen.getByText('Expiration details unavailable.')).toBeTruthy()
  })

  it('displays coupons in French and closes the list when switching providers', () => {
    useLocaleStore.getState().applyLocale('fr')
    report({ usage: { windows: [], resetCredits: { availableCount: 1, coupons: [{}] } } })
    const view = show()
    fireEvent.click(screen.getByRole('button', { name: '1 coupon de réinitialisation' }))
    expect(screen.getByText('Date d’expiration indisponible')).toBeTruthy()
    view.rerender(<ProviderUsageIndicator providerId="other" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    useLocaleStore.getState().applyLocale('en')
  })
})
