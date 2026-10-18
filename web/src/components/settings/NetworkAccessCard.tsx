import { useEffect, useState } from 'react'
import { useT } from '../../hooks/useT'
import { useConfig } from '../../hooks/useConfig'
import { updateServerNetwork } from '../../lib/resources'
import { Toggle } from '../shared/Toggle'

function ToggleRow({
  title,
  description,
  enabled,
  disabled,
  onToggle,
}: {
  title: string
  description: string
  enabled: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <label className="flex items-start justify-between gap-3 cursor-pointer">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{title}</div>
        <div className="text-sm text-text-muted mt-0.5">{description}</div>
      </div>
      <div className="flex-shrink-0">
        <Toggle enabled={enabled} onClick={disabled ? () => {} : onToggle} />
      </div>
    </label>
  )
}

/**
 * LAN access + HTTPS switches. Both are stored in the global config, and both
 * need a server restart: the listening socket and its TLS material are created
 * at startup, so the UI says so rather than pretending the change is live.
 */
export function NetworkAccessCard() {
  const t = useT()
  const { config } = useConfig()
  const network = config?.serverNetwork ?? null

  const [lanEnabled, setLanEnabled] = useState(false)
  const [httpsEnabled, setHttpsEnabled] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!network) return
    setLanEnabled(network.host !== '127.0.0.1' && network.host !== 'localhost')
    setHttpsEnabled(network.https)
  }, [network])

  if (!network) return null

  const save = async (next: { host?: string; https?: boolean }) => {
    setSaving(true)
    setError(null)
    try {
      const result = await updateServerNetwork(next)
      setRestartRequired(result.restartRequired)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
      // Fall back to what the server actually has, so the switch never lies.
      setLanEnabled(network.host !== '127.0.0.1' && network.host !== 'localhost')
      setHttpsEnabled(network.https)
    } finally {
      setSaving(false)
    }
  }

  const handleLanToggle = () => {
    const next = !lanEnabled
    setLanEnabled(next)
    void save({ host: next ? '0.0.0.0' : '127.0.0.1' })
  }

  const handleHttpsToggle = () => {
    const next = !httpsEnabled
    setHttpsEnabled(next)
    void save({ https: next })
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-text-primary mb-3">
        {t({ en: 'Local network access', fr: 'Accès réseau local' })}
      </h3>

      <div className="space-y-3">
        <ToggleRow
          title={t({ en: 'Reachable from the local network', fr: 'Accessible depuis le réseau local' })}
          description={t({
            en: 'Listens on 0.0.0.0 so other machines on this network can open the app. Without a password, anyone on the network can drive the agent.',
            fr: 'Écoute sur 0.0.0.0 pour que les autres machines du réseau puissent ouvrir l’app. Sans mot de passe, n’importe qui sur le réseau peut piloter l’agent.',
          })}
          enabled={lanEnabled}
          disabled={saving}
          onToggle={handleLanToggle}
        />

        <ToggleRow
          title={t({ en: 'HTTPS (self-signed certificate)', fr: 'HTTPS (certificat auto-signé)' })}
          description={t({
            en: 'Encrypts traffic and makes the app installable as a PWA. Each device accepts the certificate warning once.',
            fr: 'Chiffre les échanges et rend l’app installable comme PWA. Chaque appareil accepte l’avertissement de certificat une fois.',
          })}
          enabled={httpsEnabled}
          disabled={saving}
          onToggle={handleHttpsToggle}
        />
      </div>

      {lanEnabled && network.urls.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-text-secondary">
            {t({ en: 'Open on another device:', fr: 'À ouvrir sur un autre appareil :' })}
          </div>
          <div className="mt-1 space-y-0.5">
            {network.urls.map((url) => (
              <div key={url} className="font-mono text-xs text-text-primary select-all">
                {url}
              </div>
            ))}
          </div>
        </div>
      )}

      {httpsEnabled && network.certificatePath && (
        <div className="mt-3">
          <div className="text-xs text-text-secondary">{t({ en: 'Certificate:', fr: 'Certificat :' })}</div>
          <div className="mt-1 font-mono text-xs text-text-primary select-all break-all">{network.certificatePath}</div>
        </div>
      )}

      {!lanEnabled && (
        <p className="text-xs text-text-muted mt-2">
          {t({
            en: 'Only this machine can reach the server (127.0.0.1).',
            fr: 'Seule cette machine peut joindre le serveur (127.0.0.1).',
          })}
        </p>
      )}

      {restartRequired && (
        <p className="text-xs text-accent-primary mt-2">
          {t({ en: 'Restart MorrisCode to apply.', fr: 'Redémarrez MorrisCode pour appliquer.' })}
        </p>
      )}

      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  )
}
