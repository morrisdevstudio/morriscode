import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './shared/Modal'
import { authFetch } from '../lib/api'
import { appUrl } from '../lib/basePath'
import { useT } from '../hooks/useT'
import { stampPreviousVersion } from '../lib/versionTracking'

type DialogState =
  'loading' | 'ready' | 'downloading' | 'updating' | 'restarting' | 'complete' | 'failed' | 'restartFailed'

interface UpdateStatusPayload {
  flavor?: 'release' | 'npm' | 'development'
  current?: string
  latest?: string | null
  phase?: string
  updateAvailable?: boolean
  isUpdateAvailable?: boolean
  isService?: boolean
  received?: number
  total?: number
  error?: string | null
  stagedVersion?: string | null
  releaseUrl?: string | null
  notes?: string | null
}

interface UpdateDialogProps {
  isOpen: boolean
  onClose: () => void
  versionInfo: { current: string; latest: string } | null
}

const POLL_INTERVAL_MS = 1_000
const RESTART_TIMEOUT_MS = 90_000

function FallbackPanel({
  message,
  command,
  hint,
}: {
  message: string | null
  command: string
  hint: { en: string; fr: string }
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center gap-2 px-3 py-2 bg-accent-danger/10 border border-accent-danger/30 rounded text-xs">
        <span>⚠️</span>
        <p className="text-text-secondary">{message}</p>
      </div>
      <div className="bg-bg-tertiary rounded px-3 py-2 text-xs font-mono text-text-secondary">{command}</div>
      <p className="text-xs text-text-muted">{t(hint)}</p>
    </div>
  )
}

export function UpdateDialog({ isOpen, onClose, versionInfo }: UpdateDialogProps) {
  const t = useT()
  const [state, setState] = useState<DialogState>('loading')
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null)
  const [updatedVersion, setUpdatedVersion] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [restartAvailable, setRestartAvailable] = useState(false)
  const [autoRestart, setAutoRestart] = useState(false)
  const mountedRef = useRef(true)
  const previousVersionRef = useRef(versionInfo?.current ?? null)
  previousVersionRef.current = status?.current ?? previousVersionRef.current ?? versionInfo?.current ?? null

  const releaseMode = status?.flavor === 'release'
  const isNpmService = Boolean(status?.isService) && !releaseMode
  const currentVersion = status?.current ?? versionInfo?.current ?? null
  const latestVersion = status?.stagedVersion ?? status?.latest ?? versionInfo?.latest ?? null
  const progress = status?.total ? Math.min(100, Math.round(((status.received ?? 0) / status.total) * 100)) : 0

  const loadStatus = useCallback(async (): Promise<UpdateStatusPayload | null> => {
    try {
      const response = await authFetch('/api/auto-update/status')
      if (!response.ok) return null
      const data = (await response.json()) as UpdateStatusPayload
      setStatus(data)
      return data
    } catch {
      return null
    }
  }, [])

  const markApplied = useCallback((version: string) => {
    const previous = previousVersionRef.current
    if (previous && previous !== version) stampPreviousVersion(previous)
    localStorage.setItem('morriscode_updated_to', version)
    localStorage.setItem('update_pending', 'true')
  }, [])

  const waitForVersion = useCallback(
    async (version: string) => {
      const deadline = Date.now() + RESTART_TIMEOUT_MS
      while (mountedRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        try {
          const response = await fetch(appUrl('/api/auto-update/check?force=true'))
          if (!response.ok) continue
          const data = (await response.json()) as { current?: string }
          if (data.current === version) {
            markApplied(version)
            window.location.reload()
            return
          }
        } catch {
          // The server is expected to be briefly unreachable during a restart.
        }
      }
      if (mountedRef.current) {
        setErrorMessage(
          t({
            en: 'MorrisCode did not come back within 90 seconds. Restart it manually.',
            fr: 'MorrisCode n’a pas redémarré dans les 90 secondes. Redémarrez-le manuellement.',
          }),
        )
        setState('restartFailed')
      }
    },
    [markApplied, t],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    setState('loading')
    setUpdatedVersion(null)
    setErrorMessage(null)
    setRestartAvailable(false)
    setAutoRestart(false)
    void (async () => {
      const data = await loadStatus()
      if (!mountedRef.current) return
      if (!data) {
        setState('ready')
        return
      }
      if (data.phase === 'error') {
        setErrorMessage(data.error ?? null)
        setState('failed')
        return
      }
      if (data.phase === 'downloading') {
        setState('downloading')
        return
      }
      setState('ready')
    })()
  }, [isOpen, loadStatus])

  useEffect(() => {
    if (!isOpen || state !== 'downloading') return
    const timer = setInterval(() => {
      void (async () => {
        const data = await loadStatus()
        if (!mountedRef.current || !data) return
        if (data.phase === 'error') {
          setErrorMessage(data.error ?? null)
          setState('failed')
        } else if (data.phase === 'ready' || data.stagedVersion) {
          setState('ready')
        }
      })()
    }, 1_500)
    return () => clearInterval(timer)
  }, [isOpen, state, loadStatus])

  const handleInstall = useCallback(async () => {
    setState('updating')
    setErrorMessage(null)
    try {
      const response = await authFetch('/api/auto-update', { method: 'POST' })
      const data = (await response.json()) as {
        success: boolean
        version?: string
        error?: string
        restarting?: boolean
        isService?: boolean
      }
      if (!data.success) {
        setErrorMessage(data.error ?? t({ en: 'Update failed', fr: 'Échec de la mise à jour' }))
        setState('failed')
        return
      }
      const version = data.version ?? latestVersion ?? 'unknown'
      setUpdatedVersion(version)
      if (data.restarting) {
        setState('restarting')
        void waitForVersion(version)
        return
      }
      setRestartAvailable(Boolean(data.isService))
      if (autoRestart && data.isService) {
        setState('restarting')
        try {
          await authFetch('/api/auto-update/restart', { method: 'POST' })
        } catch {
          // The server may close the connection before responding.
        }
        void waitForVersion(version)
        return
      }
      setState('complete')
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t({ en: 'The update request failed', fr: 'La demande de mise à jour a échoué' }),
      )
      setState('failed')
    }
  }, [autoRestart, latestVersion, t, waitForVersion])

  const handleRestartNow = useCallback(async () => {
    const version = updatedVersion ?? latestVersion
    if (!version) return
    setState('restarting')
    try {
      await authFetch('/api/auto-update/restart', { method: 'POST' })
    } catch {
      // The server may close the connection before responding.
    }
    void waitForVersion(version)
  }, [latestVersion, updatedVersion, waitForVersion])

  const canClose = state !== 'updating' && state !== 'restarting'

  const title =
    state === 'failed'
      ? t({ en: 'Update failed', fr: 'Échec de la mise à jour' })
      : state === 'restarting'
        ? t({ en: 'Restarting…', fr: 'Redémarrage…' })
        : state === 'complete'
          ? t({ en: 'Update complete', fr: 'Mise à jour terminée' })
          : state === 'restartFailed'
            ? t({ en: 'Restart not confirmed', fr: 'Redémarrage non confirmé' })
            : state === 'downloading'
              ? t({ en: 'Downloading update', fr: 'Téléchargement de la mise à jour' })
              : state === 'ready'
                ? t({ en: 'New version ready', fr: 'Nouvelle version prête' })
                : t({ en: 'MorrisCode update', fr: 'Mise à jour de MorrisCode' })

  return (
    <Modal
      isOpen={isOpen}
      onClose={canClose ? onClose : undefined}
      title={title}
      size="md"
      closeOnBackdropClick={canClose}
      showCloseButton={canClose}
      footer={
        <div className="flex flex-col gap-2">
          {state === 'ready' && (
            <button
              onClick={() => void handleInstall()}
              className="w-full px-3 py-2 text-sm rounded bg-accent-primary hover:brightness-110 transition-all text-white font-medium"
            >
              {releaseMode
                ? t({ en: 'Install and restart', fr: 'Installer et redémarrer' })
                : t({ en: 'Update MorrisCode', fr: 'Mettre à jour MorrisCode' })}
            </button>
          )}
          {state === 'downloading' && (
            <button disabled className="w-full px-3 py-2 text-sm rounded bg-bg-tertiary text-text-muted">
              {t({ en: 'Downloading…', fr: 'Téléchargement…' })}
            </button>
          )}
          {(state === 'updating' || state === 'restarting') && (
            <p className="text-xs text-text-muted text-center py-2">
              {state === 'restarting'
                ? t({ en: 'Restarting MorrisCode…', fr: 'Redémarrage de MorrisCode…' })
                : t({ en: 'Installing the update…', fr: 'Installation de la mise à jour…' })}
            </p>
          )}
          {state === 'complete' && restartAvailable && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleRestartNow()}
                className="w-full px-3 py-2 text-sm rounded bg-accent-primary hover:brightness-110 transition-all text-white font-medium"
              >
                {t({ en: 'Restart MorrisCode now', fr: 'Redémarrer MorrisCode maintenant' })}
              </button>
              <button
                onClick={onClose}
                className="w-full px-3 py-2 text-sm rounded bg-bg-tertiary hover:bg-bg-secondary transition-colors text-text-primary font-medium"
              >
                {t({ en: 'Later', fr: 'Plus tard' })}
              </button>
            </div>
          )}
          {state === 'complete' && !restartAvailable && (
            <button
              onClick={onClose}
              className="w-full px-3 py-2 text-sm rounded bg-bg-tertiary hover:bg-bg-secondary transition-colors text-text-primary font-medium"
            >
              {t({ en: 'Close', fr: 'Fermer' })}
            </button>
          )}
          {(state === 'failed' || state === 'restartFailed') && (
            <button
              onClick={onClose}
              className="w-full px-3 py-2 text-sm rounded bg-bg-tertiary hover:bg-bg-secondary transition-colors text-text-primary font-medium"
            >
              {t({ en: 'Close', fr: 'Fermer' })}
            </button>
          )}
          {state === 'ready' && isNpmService && (
            <label className="flex items-center justify-center gap-2 text-xs text-text-muted cursor-pointer select-none">
              <input type="checkbox" checked={autoRestart} onChange={(event) => setAutoRestart(event.target.checked)} />
              {t({
                en: 'Auto-restart once the update is done',
                fr: 'Redémarrer automatiquement une fois la mise à jour terminée',
              })}
            </label>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {currentVersion && (
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">{t({ en: 'Current version', fr: 'Version actuelle' })}</span>
            <span className="text-text-primary font-mono">{currentVersion}</span>
          </div>
        )}
        {latestVersion && (
          <div className="flex justify-between text-sm pb-2">
            <span className="text-text-muted">{t({ en: 'Latest version', fr: 'Dernière version' })}</span>
            <span className="text-accent-primary font-mono font-semibold">{latestVersion}</span>
          </div>
        )}

        {(state === 'downloading' || state === 'updating' || state === 'restarting') && (
          <div className="flex flex-col gap-2 mt-2">
            <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-primary transition-all"
                style={{ width: state === 'downloading' ? `${progress}%` : '100%' }}
              />
            </div>
            {state === 'downloading' && status?.total ? (
              <p className="text-xs text-text-muted text-center">{`${progress}%`}</p>
            ) : null}
          </div>
        )}

        {status?.notes && state !== 'complete' && (
          <div className="bg-bg-tertiary rounded px-3 py-2 text-xs text-text-secondary max-h-40 overflow-auto whitespace-pre-wrap">
            {status.notes.slice(0, 2_000)}
          </div>
        )}
        {status?.releaseUrl && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-accent-primary hover:underline"
          >
            {t({ en: 'View release notes', fr: 'Voir les notes de version' })}
          </a>
        )}

        {state === 'complete' && (
          <div className="bg-bg-tertiary rounded px-3 py-2 text-xs text-text-secondary">
            {t(
              {
                en: 'MorrisCode has been updated to v{{version}}.',
                fr: 'MorrisCode a été mis à jour vers la v{{version}}.',
              },
              { version: updatedVersion ?? latestVersion ?? '' },
            )}{' '}
            {restartAvailable
              ? t({ en: 'Restart it to apply the update.', fr: 'Redémarrez-le pour appliquer la mise à jour.' })
              : releaseMode
                ? t({ en: 'The new version is active.', fr: 'La nouvelle version est active.' })
                : t({
                    en: 'Please restart MorrisCode to use the new version.',
                    fr: 'Veuillez redémarrer MorrisCode pour utiliser la nouvelle version.',
                  })}
          </div>
        )}

        {state === 'failed' && (
          <FallbackPanel
            message={errorMessage}
            command={releaseMode ? 'logs/launcher.log' : 'morriscode update'}
            hint={
              releaseMode
                ? {
                    en: 'Open the launcher log in the install folder to see why the release was rejected.',
                    fr: 'Ouvrez le journal du lanceur dans le dossier d’installation pour voir pourquoi la release a été refusée.',
                  }
                : {
                    en: 'Run this command in your terminal to complete the update.',
                    fr: 'Exécutez cette commande dans votre terminal pour terminer la mise à jour.',
                  }
            }
          />
        )}
        {state === 'restartFailed' && (
          <FallbackPanel
            message={errorMessage}
            command="morriscode service restart"
            hint={{
              en: 'Run this command to restart MorrisCode.',
              fr: 'Exécutez cette commande pour redémarrer MorrisCode.',
            }}
          />
        )}
      </div>
    </Modal>
  )
}
