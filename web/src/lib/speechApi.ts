import type { SpeechLanguage, SpeechPreparation, SpeechStatus } from '@shared/speech.js'
import { authFetch } from './api'

export class SpeechRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SpeechRequestError'
    this.status = status
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : fallback
  } catch {
    return fallback
  }
}

export async function getSpeechStatus(): Promise<SpeechStatus> {
  const response = await authFetch('/api/speech/status')
  if (!response.ok) {
    throw new SpeechRequestError(await errorMessage(response, 'Speech status unavailable'), response.status)
  }
  return (await response.json()) as SpeechStatus
}

export async function installSpeech(): Promise<SpeechStatus> {
  const response = await authFetch('/api/speech/install', { method: 'POST' })
  if (!response.ok) {
    throw new SpeechRequestError(await errorMessage(response, 'Speech installation failed'), response.status)
  }
  return (await response.json()) as SpeechStatus
}

export async function prepareSpeech(content: string, textSegments: string[] = []): Promise<SpeechPreparation> {
  const response = await authFetch('/api/speech/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, textSegments }),
  })
  if (!response.ok) {
    throw new SpeechRequestError(await errorMessage(response, 'Speech preparation failed'), response.status)
  }
  return (await response.json()) as SpeechPreparation
}

export async function synthesizeSpeech(
  text: string,
  language: SpeechLanguage,
  requestId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await authFetch('/api/speech/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language, requestId }),
    signal,
  })
  if (!response.ok) {
    throw new SpeechRequestError(await errorMessage(response, 'Speech generation failed'), response.status)
  }
  return response.blob()
}

export async function cancelSpeech(requestId: string): Promise<void> {
  try {
    await authFetch('/api/speech/synthesize/' + encodeURIComponent(requestId), {
      method: 'DELETE',
      keepalive: true,
    })
  } catch {
    // The request stream already cancels an in-flight synthesis.
  }
}
