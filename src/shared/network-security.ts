import { isIP } from 'node:net'
import type { Translation } from './i18n/index.js'

/** Only literal loopback addresses and the reserved localhost name are trusted. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  if (isIP(normalized) === 6) {
    const canonical = new URL(`http://[${normalized}]`).hostname
    return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/.test(canonical)
  }
  return false
}

export function networkAccessError(host: string, https: boolean, authenticated: boolean): Translation | null {
  if (isLoopbackHost(host)) return null
  if (!https) {
    return {
      en: 'Network access requires HTTPS. Enable HTTPS or bind to 127.0.0.1.',
      fr: 'L’accès réseau exige HTTPS. Activez HTTPS ou utilisez l’adresse 127.0.0.1.',
    }
  }
  if (!authenticated) {
    return {
      en: 'Network access requires network authentication with a working password. Configure a password before enabling network access.',
      fr: 'L’accès réseau exige une authentification réseau avec un mot de passe valide. Configurez un mot de passe avant d’activer l’accès réseau.',
    }
  }
  return null
}
