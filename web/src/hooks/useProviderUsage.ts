import { useEffect } from 'react'
import { providerUsageResource } from '../lib/resources'
import { useResourceWhen } from './useResource'

/** How often the numbers are re-read while the composer is on screen. */
const REFRESH_INTERVAL_MS = 60_000

/**
 * Metered usage of one provider, re-read every minute. Nothing is requested until a
 * provider is selected, and providers that do not meter their usage simply answer
 * nothing. The resource cache keeps the value shareable; the interval only refreshes
 * the owning key.
 */
export function useProviderUsage(providerId: string | null) {
  const enabled = providerId !== null && providerId.length > 0
  const state = useResourceWhen(enabled, providerUsageResource, providerId ?? '')
  const { refresh } = state

  useEffect(() => {
    if (!enabled) return
    const pollTimer = setInterval(() => {
      void refresh()
    }, REFRESH_INTERVAL_MS)
    return () => clearInterval(pollTimer)
  }, [enabled, refresh])

  return state
}
