import { Router } from 'express'
import { prepareSpeechMessage, type SpeechLanguage } from '../../shared/speech.js'
import { serverT } from '../i18n.js'
import { SpeechBusyError, SpeechCanceledError, SpeechNotInstalledError, type SpeechEngine } from '../speech/service.js'

const MAX_MESSAGE_CHARACTERS = 200_000
const MAX_CHUNK_CHARACTERS = 600

function parseLanguage(value: unknown): SpeechLanguage | null {
  return value === 'fr' || value === 'en' ? value : null
}

export function createSpeechRoutes(service: SpeechEngine): Router {
  const router = Router()

  router.get('/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(service.getStatus())
  })

  router.post('/install', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.status(202).json(service.install())
  })

  router.post('/prepare', (req, res) => {
    const body = req.body as { content?: unknown; textSegments?: unknown }
    if (typeof body.content !== 'string' || body.content.length > MAX_MESSAGE_CHARACTERS) {
      return res
        .status(400)
        .json({ error: serverT({ en: 'Invalid message content', fr: 'Contenu du message invalide' }) })
    }
    const segments = Array.isArray(body.textSegments)
      ? body.textSegments.filter((segment): segment is string => typeof segment === 'string').slice(0, 500)
      : []
    if (segments.join('').length > MAX_MESSAGE_CHARACTERS) {
      return res
        .status(400)
        .json({ error: serverT({ en: 'Message is too long to read', fr: 'Message trop long à lire' }) })
    }
    const prepared = prepareSpeechMessage(body.content, segments)
    if (prepared.chunks.length === 0) {
      return res.status(422).json({
        error: serverT({ en: 'No readable text in this response', fr: 'Aucun texte lisible dans cette réponse' }),
      })
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(prepared)
  })

  router.post('/synthesize', async (req, res) => {
    const body = req.body as { text?: unknown; language?: unknown; requestId?: unknown }
    const language = parseLanguage(body.language)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const requestId =
      typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 100
        ? body.requestId
        : undefined
    if (!language || !text || text.length > MAX_CHUNK_CHARACTERS) {
      return res
        .status(400)
        .json({ error: serverT({ en: 'Invalid speech request', fr: 'Demande de lecture invalide' }) })
    }

    let disconnected = false
    res.on('close', () => {
      if (!res.writableEnded) {
        disconnected = true
        if (requestId) service.cancel(requestId)
      }
    })

    try {
      const result = await service.generate(text, language, requestId)
      if (disconnected) return
      res.setHeader('Content-Type', 'audio/wav')
      res.setHeader('Content-Length', String(result.audio.length))
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Speech-Generation-Ms', String(result.generationMs))
      res.setHeader('X-Speech-Duration-Ms', String(result.durationMs))
      res.end(result.audio)
    } catch (error) {
      if (disconnected) return
      if (error instanceof SpeechCanceledError) {
        return res.status(204).end()
      }
      if (error instanceof SpeechNotInstalledError) {
        return res.status(503).json({
          error: serverT({ en: 'Local speech engine is not installed', fr: 'Le moteur vocal local est introuvable' }),
        })
      }
      if (error instanceof SpeechBusyError) {
        return res
          .status(409)
          .json({ error: serverT({ en: 'Speech engine is already busy', fr: 'Le moteur vocal est déjà occupé' }) })
      }
      res.status(500).json({ error: serverT({ en: 'Speech generation failed', fr: 'La génération vocale a échoué' }) })
    }
  })

  router.delete('/synthesize/:requestId', (req, res) => {
    const requestId = req.params.requestId as string
    service.cancel(requestId)
    res.status(204).end()
  })

  return router
}
