// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  synthesizeSpeech: vi.fn(),
  cancelSpeech: vi.fn(),
}))

vi.mock('../lib/speechApi', () => api)

import { pauseSpeech, resumeSpeech, startSpeech, stopSpeech, useSpeechPlaybackStore } from './speechPlayback'

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ''
  preload = ''
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = true

  constructor() {
    FakeAudio.instances.push(this)
  }

  play() {
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }

  removeAttribute() {
    this.src = ''
  }

  load() {}
}

describe('speech playback store', () => {
  beforeEach(() => {
    stopSpeech()
    vi.stubGlobal('Audio', FakeAudio)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:speech') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    api.cancelSpeech.mockReset()
    api.cancelSpeech.mockResolvedValue(undefined)
    api.synthesizeSpeech.mockReset()
    api.synthesizeSpeech.mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' }))
  })

  afterEach(() => {
    stopSpeech()
  })

  it('plays, pauses, resumes and stops a response', async () => {
    startSpeech('message-1', ['First part.', 'Second part.'])
    await vi.waitFor(() => expect(useSpeechPlaybackStore.getState().status).toBe('playing'))

    pauseSpeech()
    expect(useSpeechPlaybackStore.getState().status).toBe('paused')

    resumeSpeech()
    await vi.waitFor(() => expect(useSpeechPlaybackStore.getState().status).toBe('playing'))

    stopSpeech()
    expect(useSpeechPlaybackStore.getState()).toMatchObject({
      activeMessageId: null,
      status: 'idle',
      chunkIndex: 0,
    })
  })

  it('switches to another message and cancels pending audio', async () => {
    startSpeech('message-1', ['First response.'])
    await vi.waitFor(() => expect(useSpeechPlaybackStore.getState().status).toBe('playing'))

    startSpeech('message-2', ['Second response.'])
    expect(useSpeechPlaybackStore.getState().activeMessageId).toBe('message-2')
    await vi.waitFor(() => expect(useSpeechPlaybackStore.getState().status).toBe('playing'))
  })

  it('moves to the next chunk when audio ends', async () => {
    startSpeech('message-1', ['First part.', 'Second part.'])
    await vi.waitFor(() => expect(useSpeechPlaybackStore.getState().status).toBe('playing'))
    await vi.waitFor(() => expect(api.synthesizeSpeech).toHaveBeenCalledTimes(2))

    FakeAudio.instances.at(-1)!.onended?.()
    await vi.waitFor(() =>
      expect(useSpeechPlaybackStore.getState()).toMatchObject({ chunkIndex: 1, status: 'playing' }),
    )
  })
})
