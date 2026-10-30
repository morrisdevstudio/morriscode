import { useEffect, useState } from 'react'
import type { ProviderUsageWindow } from '@shared/types.js'
import { useProviderUsage } from '../../hooks/useProviderUsage'
import { useT } from '../../hooks/useT'
import { useLocaleStore } from '../../stores/locale'
import { Modal } from './Modal'

/** Above this share, a window switches to the warning colour. */
const WARNING_PERCENT = 80

type Translate = ReturnType<typeof useT>

/** 300 minutes reads as `5h`, 10080 as `7d`. No label when the backend omits the length. */
function windowLabel(minutes: number | undefined, t: Translate): string | null {
  if (!minutes || minutes <= 0) return null
  if (minutes % 1440 === 0) return t({ en: `${minutes / 1440}d`, fr: `${minutes / 1440} j` })
  if (minutes % 60 === 0) return t({ en: `${minutes / 60}h`, fr: `${minutes / 60} h` })
  return t({ en: `${minutes}min`, fr: `${minutes} min` })
}

function percentText(usedPercent: number, t: Translate): string {
  const rounded = Math.round(usedPercent)
  return t({ en: `${rounded}%`, fr: `${rounded} %` })
}

function chipText(window: ProviderUsageWindow, t: Translate): string {
  const label = windowLabel(window.windowMinutes, t)
  const percent = percentText(window.usedPercent, t)
  return label ? `${label} ${percent}` : percent
}

function chipTitle(window: ProviderUsageWindow, t: Translate): string {
  const percent = percentText(window.usedPercent, t)
  if (!window.resetsAt) return percent
  const time = new Date(window.resetsAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return t(
    { en: `${percent} used, resets at {{time}}`, fr: `${percent} utilisés, réinitialisation à {{time}}` },
    { time },
  )
}

/**
 * Metered usage of the selected provider: the short slot and the weekly window,
 * side by side next to the provider selector. Providers that do not meter their
 * usage show nothing at all, so the bar keeps its usual shape.
 */
export function ProviderUsageIndicator({ providerId }: { providerId: string | null }) {
  const t = useT()
  const locale = useLocaleStore((state) => state.locale)
  const [showCoupons, setShowCoupons] = useState(false)
  useEffect(() => setShowCoupons(false), [providerId])
  const { data } = useProviderUsage(providerId)
  const windows = data?.usage?.windows ?? []
  const resets = data?.usage?.resetCredits
  const countLabel =
    resets?.availableCount == null
      ? t({ en: 'Reset coupons unavailable', fr: 'Coupons de réinitialisation indisponibles' })
      : t(
          {
            en: { one: '{{count}} reset coupon', other: '{{count}} reset coupons' },
            fr: { one: '{{count}} coupon de réinitialisation', other: '{{count}} coupons de réinitialisation' },
          },
          { count: resets.availableCount },
        )
  const firstExpiry = resets?.coupons?.find((coupon) => typeof coupon.expiresAt === 'number')?.expiresAt

  if (windows.length === 0 && !resets) return null

  return (
    <div className="flex items-center gap-1.5" data-testid="provider-usage">
      {windows.map((window, index) => {
        const classes = window.usedPercent >= WARNING_PERCENT ? 'text-accent-warning' : 'text-text-muted'
        return (
          <span
            key={index}
            data-testid={`provider-usage-window-${index}`}
            className={`text-xs whitespace-nowrap tabular-nums ${classes}`}
            title={chipTitle(window, t)}
          >
            {chipText(window, t)}
          </span>
        )
      })}
      {resets && (
        <>
          <button
            type="button"
            onClick={() => setShowCoupons(true)}
            aria-label={countLabel}
            aria-haspopup="dialog"
            aria-expanded={showCoupons}
            title={countLabel}
            className="rounded px-1.5 py-0.5 text-xs whitespace-nowrap text-text-secondary hover:text-text-primary hover:bg-bg-tertiary"
          >
            {resets.availableCount == null
              ? t({ en: 'Coupons unavailable', fr: 'Coupons indisponibles' })
              : t(
                  {
                    en: { one: '{{count}} coupon', other: '{{count}} coupons' },
                    fr: { one: '{{count}} coupon', other: '{{count}} coupons' },
                  },
                  { count: resets.availableCount },
                )}
            {firstExpiry != null && (
              <span
                className="ml-1 text-text-muted"
                title={t(
                  { en: 'Next expiration: {{date}}', fr: 'Prochaine expiration : {{date}}' },
                  { date: new Date(firstExpiry * 1000).toLocaleString(locale) },
                )}
              >
                {t(
                  { en: '· {{date}}', fr: '· {{date}}' },
                  {
                    date: new Date(firstExpiry * 1000).toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
                  },
                )}
              </span>
            )}
          </button>
          <Modal
            isOpen={showCoupons}
            onClose={() => setShowCoupons(false)}
            title={t({ en: 'Usage reset coupons', fr: 'Coupons de réinitialisation' })}
            size="sm"
          >
            <p className="text-sm text-text-primary mb-3">{countLabel}</p>
            {resets.availableCount === 0 ? (
              <p className="text-sm text-text-muted">
                {t({ en: 'No reset coupons available.', fr: 'Aucun coupon de réinitialisation disponible.' })}
              </p>
            ) : resets.coupons && resets.coupons.length > 0 ? (
              <ul className="space-y-3">
                {resets.coupons.map((coupon, index) => (
                  <li key={index} className="rounded border border-border p-3">
                    <div className="text-sm text-text-primary">
                      {t(
                        { en: 'Reset coupon {{number}}', fr: 'Coupon de réinitialisation {{number}}' },
                        { number: index + 1 },
                      )}
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      {coupon.expiresAt === null
                        ? t({ en: 'No expiration date', fr: 'Sans date d’expiration' })
                        : coupon.expiresAt === undefined
                          ? t({ en: 'Expiration date unavailable', fr: 'Date d’expiration indisponible' })
                          : t(
                              { en: 'Expires {{date}}', fr: 'Expire le {{date}}' },
                              {
                                date: new Date(coupon.expiresAt * 1000).toLocaleString(locale, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  timeZoneName: 'short',
                                }),
                              },
                            )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">
                {t({ en: 'Expiration details unavailable.', fr: 'Détails d’expiration indisponibles.' })}
              </p>
            )}
            {resets.coupons &&
              resets.availableCount != null &&
              resets.coupons.length > 0 &&
              resets.coupons.length < resets.availableCount && (
                <p className="mt-3 text-xs text-text-muted">
                  {t({
                    en: 'Expiration details are unavailable for some coupons.',
                    fr: 'Les dates d’expiration de certains coupons sont indisponibles.',
                  })}
                </p>
              )}
            <p className="mt-4 text-xs text-text-muted">
              {t({
                en: 'Read-only. Use your coupons in ChatGPT; none can be redeemed here.',
                fr: 'Consultation uniquement. Utilise tes coupons dans ChatGPT ; aucun ne peut être consommé ici.',
              })}
            </p>
          </Modal>
        </>
      )}
    </div>
  )
}
