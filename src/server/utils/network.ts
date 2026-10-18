import os from 'node:os'
import { statSync } from 'node:fs'
import { VERSION } from '../../constants.js'
import { serverT } from '../i18n.js'

export interface NetworkInterface {
  ip: string
  family: 'IPv4' | 'IPv6'
  name: string
}

export function getNetworkInterfaces(): NetworkInterface[] {
  const interfaces = os.networkInterfaces()
  const result: NetworkInterface[] = []

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue

    for (const addr of addresses) {
      if (addr.family === 'IPv4') {
        result.push({
          ip: addr.address,
          family: 'IPv4',
          name,
        })
      }
    }
  }

  return result
}

export function getValidIPv4Addresses(): string[] {
  const interfaces = getNetworkInterfaces()

  // Filter out loopback and internal addresses
  const valid = interfaces
    .filter((addr) => {
      // Exclude loopback
      if (addr.ip.startsWith('127.')) return false
      // Exclude link-local
      if (addr.ip.startsWith('169.254.')) return false
      // Exclude unique local addresses (fc00::/7 for IPv6, but we're only looking at IPv4)
      return true
    })
    .map((addr) => addr.ip)

  // Sort: prefer eth*, wlan*, then others
  const sorted = valid.sort((a, b) => {
    const aInterface = interfaces.find((i) => i.ip === a)?.name || ''
    const bInterface = interfaces.find((i) => i.ip === b)?.name || ''

    // Prefer eth* interfaces
    if (aInterface.startsWith('eth') && !bInterface.startsWith('eth')) return -1
    if (!aInterface.startsWith('eth') && bInterface.startsWith('eth')) return 1

    // Then prefer wlan* interfaces
    if (aInterface.startsWith('wlan') && !bInterface.startsWith('wlan')) return -1
    if (!aInterface.startsWith('wlan') && bInterface.startsWith('wlan')) return 1

    return 0
  })

  return sorted
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0KB'

  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024

  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)}GB`
  } else if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)}MB`
  } else {
    return `${Math.round(bytes / KB)}KB`
  }
}

export function getDatabaseSize(databasePath: string): string {
  try {
    const stats = statSync(databasePath)
    return formatFileSize(stats.size)
  } catch {
    return '0KB'
  }
}

export function serverScheme(httpsEnabled: boolean): 'http' | 'https' {
  return httpsEnabled ? 'https' : 'http'
}

/**
 * URLs a peer can actually open: the loopback alias when the server is bound to
 * localhost, otherwise every LAN address (falling back to the bind address when
 * no usable interface is found).
 */
export function getServerUrls(config: { host: string; port: number; https?: boolean | undefined }): string[] {
  const scheme = serverScheme(config.https === true)

  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    return [`${scheme}://localhost:${config.port}`]
  }

  const ips = getValidIPv4Addresses()
  if (ips.length === 0) {
    return [`${scheme}://${config.host}:${config.port}`]
  }

  return ips.map((ip) => `${scheme}://${ip}:${config.port}`)
}

export function displayStartupBanner(config: {
  host: string
  port: number
  databasePath: string
  configPath: string
  https?: boolean
  certificate?: { certPath: string; generated: boolean }
}): void {
  const { host, port, databasePath, configPath } = config
  const https = config.https === true
  const isLocalhost = host === '127.0.0.1'
  const urls = getServerUrls({ host, port, https })

  // eslint-disable-next-line no-console
  console.log(`\nMorrisCode v${VERSION}\n`)

  if (isLocalhost) {
    // eslint-disable-next-line no-console
    console.log(
      `  🌐 ${serverT({ en: `Server: ${urls[0] ?? serverScheme(https)}://localhost:${port}`, fr: `Serveur : ${urls[0] ?? serverScheme(https)}://localhost:${port}` })}`,
    )
    // eslint-disable-next-line no-console
    console.log(`  🔒 ${serverT({ en: 'Access: Localhost only', fr: 'Accès : localhost uniquement' })}`)
  } else {
    const ips = getValidIPv4Addresses()

    if (ips.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`  🌐 ${serverT({ en: `Server: ${urls[0] ?? ''}`, fr: `Serveur : ${urls[0] ?? ''}` })}`)

      console.warn(
        `  ⚠️  ${serverT({ en: 'Warning: No valid network interfaces detected', fr: 'Avertissement : aucune interface réseau valide détectée' })}`,
      )
    } else {
      // eslint-disable-next-line no-console
      console.log(`  🌐 ${serverT({ en: 'Server:', fr: 'Serveur :' })}`)
      for (const url of urls) {
        // eslint-disable-next-line no-console
        console.log(`     • ${url}`)
      }
      // eslint-disable-next-line no-console
      console.log(`  🌍 ${serverT({ en: 'Access: Local network', fr: 'Accès : réseau local' })}`)
    }
  }

  if (https) {
    // eslint-disable-next-line no-console
    console.log(
      `  🔐 ${serverT({ en: 'HTTPS: enabled (self-signed certificate)', fr: 'HTTPS : activé (certificat auto-signé)' })}`,
    )

    if (config.certificate) {
      // eslint-disable-next-line no-console
      console.log(
        `     ${serverT({
          en: `Certificate: ${config.certificate.certPath}`,
          fr: `Certificat : ${config.certificate.certPath}`,
        })}`,
      )
    }

    // eslint-disable-next-line no-console
    console.log(
      `     ${serverT({
        en: 'Accept the certificate warning once per device — see docs/NETWORK-ACCESS.md',
        fr: 'Acceptez l’avertissement de certificat une fois par appareil — voir docs/NETWORK-ACCESS.md',
      })}`,
    )
  }

  const size = getDatabaseSize(databasePath)
  // eslint-disable-next-line no-console
  console.log(
    `  💾 ${serverT({ en: `Database: ${databasePath} (${size})`, fr: `Base de données : ${databasePath} (${size})` })}`,
  )
  // eslint-disable-next-line no-console
  console.log(`  ⚙️  ${serverT({ en: `Config:  ${configPath}`, fr: `Config :  ${configPath}` })}`)
  // eslint-disable-next-line no-console
  console.log(
    `\n💡 ${serverT({ en: 'Tip: Press Ctrl+C to stop the server', fr: 'Astuce : appuyez sur Ctrl+C pour arrêter le serveur' })}\n`,
  )
}
