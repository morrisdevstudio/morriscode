import { useEffect, useMemo, useState } from 'react'
import type { SpeechStatus } from '@shared/speech.js'
import { prepareSpeechMessage } from '@shared/speech.js'
import { useT } from '../../hooks/useT'
import { getSpeechStatus, installSpeech, prepareSpeech, SpeechRequestError } from '../../lib/speechApi'
import {
  pauseSpeech,
  resumeSpeech,
  setSpeechLanguage,
  startSpeech,
  stopSpeech,
  useSpeechPlaybackStore,
} from '../../stores/speechPlayback'
import { PauseIcon, PlayIcon, SpeakerIcon, SpinIcon, StopIcon } from '../shared/icons'
import { Modal } from '../shared/Modal'

interface SpeechButtonProps {
  messageId: string
  content: string
  textSegments?: string[]
  isStreaming?: boolean
}

function stageLabel(t: ReturnType<typeof useT>, status: SpeechStatus): string {
  switch (status.stage) {
    case 'preparing':
      return t({ en: 'Preparing installation', fr: 'Préparation de l’installation' })
    case 'creating-environment':
      return t({ en: 'Creating the isolated environment', fr: 'Création de l’environnement isolé' })
    case 'installing-engine':
      return t({ en: 'Installing the speech engine', fr: 'Installation du moteur vocal' })
    case 'downloading-model':
      return t({ en: 'Downloading the voice model', fr: 'Téléchargement du modèle vocal' })
    case 'downloading-voices':
      return t({ en: 'Downloading the French and English voices', fr: 'Téléchargement des voix française et anglaise' })
    case 'verifying':
      return t({ en: 'Checking the installation', fr: 'Vérification de l’installation' })
    default:
      return t({ en: 'Voice narration', fr: 'Lecture vocale' })
  }
}

function SpeechInstallDialog({
  isOpen,
  initialStatus,
  onClose,
  onReady,
}: {
  isOpen: boolean
  initialStatus: SpeechStatus | null
  onClose: () => void
  onReady: () => void
}) {
  const t = useT()
  const [status, setStatus] = useState<SpeechStatus | null>(initialStatus)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setFailure(null)
    void getSpeechStatus()
      .then((next) => {
        if (cancelled) return
        setStatus(next)
      })
      .catch(() => {
        if (!cancelled)
          setFailure(t({ en: 'Could not check the voice engine.', fr: 'Impossible de vérifier le moteur vocal.' }))
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, t])

  useEffect(() => {
    if (!isOpen || status?.state !== 'installing') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void getSpeechStatus()
        .then((next) => {
          if (!cancelled) setStatus(next)
        })
        .catch(() => {
          if (!cancelled) {
            setFailure(
              t({ en: 'Installation status is unavailable.', fr: 'L’état de l’installation est indisponible.' }),
            )
          }
        })
    }, 900)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [isOpen, status?.state, status?.progress, t])

  const beginInstall = async () => {
    setPending(true)
    setFailure(null)
    try {
      const next = await installSpeech()
      setStatus(next)
    } catch {
      setFailure(t({ en: 'Could not start the installation.', fr: 'Impossible de démarrer l’installation.' }))
    } finally {
      setPending(false)
    }
  }

  const installed = status?.state === 'ready'
  const failed = status?.state === 'error'
  const installerMissing = status?.error?.includes('uv') ?? false
  const installing = status?.state === 'installing' || pending
  const progress = Math.round(status?.progress ?? 0)

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t({ en: 'Local voice narration', fr: 'Lecture vocale locale' })}
      size="md"
    >
      <div className="space-y-4 text-sm text-text-secondary">
        <p>
          {t({
            en: 'MorrisCode reads explanations aloud on this computer with a small local model. The model runs on the processor and never uses the graphics card.',
            fr: 'MorrisCode lit les explications à voix haute sur cet ordinateur avec un petit modèle local. Le modèle utilise le processeur et jamais la carte graphique.',
          })}
        </p>
        <p className="text-xs text-text-muted">
          {t({
            en: 'The guided installation downloads about 142 MB once. Later readings work offline.',
            fr: 'L’installation guidée télécharge environ 142 Mo une seule fois. Les lectures suivantes fonctionnent hors connexion.',
          })}
        </p>

        {installing && status && (
          <div className="space-y-2 rounded-lg border border-border bg-bg-tertiary/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <span>{stageLabel(t, status)}</span>
              <span className="tabular-nums text-text-primary">{progress + '%'}</span>
            </div>
            <progress
              className="h-1.5 w-full overflow-hidden rounded accent-accent-primary"
              max={100}
              value={progress}
            />
          </div>
        )}

        {installed && (
          <p className="rounded-lg border border-accent-success/30 bg-accent-success/10 p-3 text-text-primary">
            {t({ en: 'The voice engine is ready.', fr: 'Le moteur vocal est prêt.' })}
          </p>
        )}

        {(failed || failure) && (
          <p role="alert" className="rounded-lg border border-accent-error/30 bg-accent-error/10 p-3 text-accent-error">
            {failure ??
              (installerMissing
                ? t({
                    en: 'The uv package installer is required. Install uv, then retry.',
                    fr: 'L’installeur uv est nécessaire. Installez uv, puis réessayez.',
                  })
                : t({
                    en: 'The installation did not finish. You can retry safely.',
                    fr: 'L’installation ne s’est pas terminée. Vous pouvez réessayer sans risque.',
                  }))}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            {t({ en: 'Close', fr: 'Fermer' })}
          </button>
          {installed ? (
            <button
              type="button"
              onClick={onReady}
              className="rounded-md bg-accent-primary px-4 py-2 font-medium text-white transition-opacity hover:opacity-90"
            >
              {t({ en: 'Read this response', fr: 'Lire cette réponse' })}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void beginInstall()}
              disabled={installing}
              className="rounded-md bg-accent-primary px-4 py-2 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installing
                ? t({ en: 'Installing…', fr: 'Installation…' })
                : failed
                  ? t({ en: 'Retry installation', fr: 'Réessayer l’installation' })
                  : t({ en: 'Install voice engine', fr: 'Installer le moteur vocal' })}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function SpeechButton({ messageId, content, textSegments = [], isStreaming = false }: SpeechButtonProps) {
  const t = useT()
  const playback = useSpeechPlaybackStore((state) => state)
  const [checking, setChecking] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [installStatus, setInstallStatus] = useState<SpeechStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const preparation = useMemo(() => prepareSpeechMessage(content, textSegments), [content, textSegments])
  const active = playback.activeMessageId === messageId && playback.status !== 'idle'
  const localStatus = active ? playback.status : 'idle'
  const visibleFailure =
    failure ??
    (playback.activeMessageId === messageId && playback.error
      ? t({ en: 'Could not read this response.', fr: 'Impossible de lire cette réponse.' })
      : null)

  const beginPlayback = async () => {
    setFailure(null)
    setChecking(true)
    try {
      const status = await getSpeechStatus()
      setInstallStatus(status)
      if (!status.installed) {
        setInstallOpen(true)
        return
      }
      const prepared = await prepareSpeech(content, textSegments)
      startSpeech(messageId, prepared.chunks)
    } catch (error) {
      setFailure(
        error instanceof SpeechRequestError && error.status === 422
          ? t({ en: 'This response has no readable text.', fr: 'Cette réponse ne contient aucun texte lisible.' })
          : t({ en: 'Could not start voice narration.', fr: 'Impossible de démarrer la lecture vocale.' }),
      )
    } finally {
      setChecking(false)
    }
  }

  const handlePrimary = () => {
    if (!active) {
      void beginPlayback()
      return
    }
    if (localStatus === 'playing') pauseSpeech()
    else if (localStatus === 'paused') resumeSpeech()
    else stopSpeech()
  }

  const handleReady = async () => {
    setInstallOpen(false)
    await beginPlayback()
  }

  if (isStreaming || preparation.chunks.length === 0) return null

  return (
    <div className="mt-2 flex min-h-7 items-center gap-1 text-text-muted">
      {active ? (
        <>
          <button
            type="button"
            onClick={handlePrimary}
            disabled={localStatus === 'preparing'}
            aria-label={
              localStatus === 'playing'
                ? t({ en: 'Pause voice narration', fr: 'Mettre la lecture en pause' })
                : t({ en: 'Resume voice narration', fr: 'Reprendre la lecture vocale' })
            }
            title={
              localStatus === 'playing'
                ? t({ en: 'Pause voice narration', fr: 'Mettre la lecture en pause' })
                : t({ en: 'Resume voice narration', fr: 'Reprendre la lecture vocale' })
            }
            className="rounded p-1.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            {localStatus === 'preparing' ? (
              <SpinIcon className="h-3.5 w-3.5 animate-spin" />
            ) : localStatus === 'playing' ? (
              <PauseIcon className="h-3.5 w-3.5" />
            ) : (
              <PlayIcon className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={stopSpeech}
            aria-label={t({ en: 'Stop voice narration', fr: 'Arrêter la lecture vocale' })}
            title={t({ en: 'Stop voice narration', fr: 'Arrêter la lecture vocale' })}
            className="rounded p-1.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <StopIcon className="h-3 w-3" />
          </button>
          {playback.chunkCount > 1 && (
            <span className="tabular-nums text-[10px]">
              {playback.chunkIndex + 1}/{playback.chunkCount}
            </span>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={handlePrimary}
          disabled={checking}
          aria-label={t({ en: 'Read this response aloud', fr: 'Lire cette réponse à voix haute' })}
          title={t({ en: 'Read this response aloud', fr: 'Lire cette réponse à voix haute' })}
          className="rounded p-1.5 transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          {checking ? <SpinIcon className="h-3.5 w-3.5 animate-spin" /> : <SpeakerIcon className="h-4 w-4" />}
        </button>
      )}
      <label className="sr-only" htmlFor={'speech-language-' + messageId}>
        {t({ en: 'Voice language', fr: 'Langue de lecture' })}
      </label>
      <select
        id={'speech-language-' + messageId}
        value={playback.language}
        disabled={active}
        onChange={(event) => setSpeechLanguage(event.target.value === 'en' ? 'en' : 'fr')}
        aria-label={t({ en: 'Voice language', fr: 'Langue de lecture' })}
        title={t({ en: 'Voice language', fr: 'Langue de lecture' })}
        className="rounded border border-border bg-transparent px-1 py-0.5 text-[10px] uppercase text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
      >
        <option value="fr">{t({ en: 'French', fr: 'Français' })}</option>
        <option value="en">{t({ en: 'English', fr: 'Anglais' })}</option>
      </select>
      {visibleFailure && (
        <span role="status" className="ml-1 text-[10px] text-accent-error">
          {visibleFailure}
        </span>
      )}
      <SpeechInstallDialog
        isOpen={installOpen}
        initialStatus={installStatus}
        onClose={() => setInstallOpen(false)}
        onReady={() => void handleReady()}
      />
    </div>
  )
}
