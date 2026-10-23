import { create } from 'zustand'
import type { SpeechLanguage } from '@shared/speech.js'
import { cancelSpeech, synthesizeSpeech } from '../lib/speechApi'

export type SpeechPlaybackStatus = 'idle' | 'preparing' | 'playing' | 'paused' | 'error'

interface SpeechPlaybackState {
  activeMessageId: string | null
  status: SpeechPlaybackStatus
  language: SpeechLanguage
  error: 'synthesis' | null
  chunkIndex: number
  chunkCount: number
}

export const useSpeechPlaybackStore = create<SpeechPlaybackState>(() => ({
  activeMessageId: null,
  status: 'idle',
  language: 'fr',
  error: null,
  chunkIndex: 0,
  chunkCount: 0,
}))

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA='

let audio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let chunks: string[] = []
let generation = 0
let currentIndex = 0
let activeRequestId: string | null = null
let fetchController: AbortController | null = null
const prepared = new Map<number, Blob>()
const inFlight = new Map<number, { promise: Promise<Blob>; controller: AbortController; id: string }>()

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio()
    audio.preload = 'auto'
  }
  return audio
}

function setState(update: Partial<SpeechPlaybackState>): void {
  useSpeechPlaybackStore.setState(update)
}

function revokeCurrentUrl(): void {
  if (!currentUrl) return
  URL.revokeObjectURL(currentUrl)
  currentUrl = null
}

function resetPlayback(): void {
  generation += 1
  fetchController?.abort()
  fetchController = null
  for (const request of inFlight.values()) request.controller.abort()
  inFlight.clear()
  if (activeRequestId) {
    void cancelSpeech(activeRequestId)
    activeRequestId = null
  }
  prepared.clear()
  chunks = []
  currentIndex = 0
  revokeCurrentUrl()
  if (audio) {
    audio.pause()
    audio.onended = null
    audio.onerror = null
    audio.removeAttribute('src')
    audio.load()
  }
  setState({
    activeMessageId: null,
    status: 'idle',
    error: null,
    chunkIndex: 0,
    chunkCount: 0,
  })
}

function requestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
}

function cancelPreparedRequest(): void {
  fetchController?.abort()
  fetchController = null
  if (activeRequestId) {
    void cancelSpeech(activeRequestId)
    activeRequestId = null
  }
  inFlight.clear()
}

async function getChunk(index: number, token: number): Promise<Blob> {
  const cached = prepared.get(index)
  if (cached) return cached
  if (index < 0 || index >= chunks.length) throw new Error('speech chunk out of range')
  const pending = inFlight.get(index)
  if (pending) return pending.promise

  const id = requestId()
  const controller = new AbortController()
  activeRequestId = id
  fetchController = controller
  const promise = synthesizeSpeech(
    chunks[index]!,
    useSpeechPlaybackStore.getState().language,
    id,
    controller.signal,
  ).then((blob) => {
    if (token !== generation) throw new DOMException('Playback canceled', 'AbortError')
    prepared.set(index, blob)
    return blob
  })
  inFlight.set(index, { promise, controller, id })
  try {
    return await promise
  } finally {
    if (inFlight.get(index)?.controller === controller) inFlight.delete(index)
    if (activeRequestId === id) activeRequestId = null
    if (fetchController === controller) fetchController = null
  }
}

async function prefetch(index: number, token: number): Promise<void> {
  if (index >= chunks.length || prepared.has(index)) return
  try {
    await getChunk(index, token)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (token !== generation) return
    resetPlayback()
    setState({ status: 'error', error: 'synthesis' })
  }
}

async function playIndex(index: number, token: number): Promise<void> {
  if (token !== generation || index >= chunks.length) return
  currentIndex = index
  setState({ status: 'preparing', chunkIndex: index })
  try {
    const blob = await getChunk(index, token)
    if (token !== generation) return

    const element = getAudio()
    revokeCurrentUrl()
    currentUrl = URL.createObjectURL(blob)
    element.src = currentUrl
    element.onended = () => {
      if (token !== generation) return
      const next = currentIndex + 1
      if (next >= chunks.length) {
        resetPlayback()
        return
      }
      void playIndex(next, token)
    }
    element.onerror = () => {
      if (token !== generation) return
      resetPlayback()
      setState({ status: 'error', error: 'synthesis' })
    }
    await element.play()
    if (token !== generation) {
      element.pause()
      return
    }
    setState({ status: 'playing', error: null, chunkIndex: index })
    void prefetch(index + 1, token)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (token !== generation) return
    resetPlayback()
    setState({ status: 'error', error: 'synthesis' })
  }
}

export function startSpeech(messageId: string, nextChunks: string[]): void {
  if (nextChunks.length === 0) return
  resetPlayback()
  const token = generation
  chunks = [...nextChunks]
  prepared.clear()
  setState({
    activeMessageId: messageId,
    status: 'preparing',
    error: null,
    chunkIndex: 0,
    chunkCount: chunks.length,
  })

  // Prime the media element inside the click gesture. Mobile browsers can
  // otherwise reject play() after the asynchronous synthesis request.
  const element = getAudio()
  element.onended = null
  element.src = SILENT_WAV
  void element.play().catch(() => {})
  void playIndex(0, token)
}

export function pauseSpeech(): void {
  if (!audio || useSpeechPlaybackStore.getState().status !== 'playing') return
  audio.pause()
  cancelPreparedRequest()
  setState({ status: 'paused' })
}

export function resumeSpeech(): void {
  if (!audio || useSpeechPlaybackStore.getState().status !== 'paused') return
  void audio
    .play()
    .then(() => {
      setState({ status: 'playing' })
      void prefetch(currentIndex + 1, generation)
    })
    .catch(() => {
      resetPlayback()
      setState({ status: 'error', error: 'synthesis' })
    })
}

export function stopSpeech(): void {
  resetPlayback()
}

export function setSpeechLanguage(language: SpeechLanguage): void {
  setState({ language })
}
