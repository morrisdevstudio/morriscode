// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  getSpeechStatus: vi.fn(),
  installSpeech: vi.fn(),
  prepareSpeech: vi.fn(),
  synthesizeSpeech: vi.fn(),
  cancelSpeech: vi.fn(),
}))

vi.mock('../../lib/speechApi', () => ({
  ...api,
  SpeechRequestError: class SpeechRequestError extends Error {
    status = 500
  },
}))

import { SpeechButton } from './SpeechButton'
import { stopSpeech } from '../../stores/speechPlayback'

const ready = {
  state: 'ready',
  installed: true,
  stage: 'verifying',
  progress: 100,
  cpuOnly: true,
  voice: 'ff_siwis',
}

describe('SpeechButton', () => {
  beforeEach(() => {
    api.getSpeechStatus.mockReset()
    api.installSpeech.mockReset()
    api.prepareSpeech.mockReset()
    api.synthesizeSpeech.mockReset()
    api.cancelSpeech.mockReset()
    api.getSpeechStatus.mockResolvedValue(ready)
    api.prepareSpeech.mockResolvedValue({ chunks: ['Explain this.'], characterCount: 13 })
    api.installSpeech.mockResolvedValue({ ...ready, state: 'installing', installed: false, progress: 1 })
    api.cancelSpeech.mockResolvedValue(undefined)
    api.synthesizeSpeech.mockImplementation(
      (_text: string, _language: string, _requestId: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    stopSpeech()
  })

  afterEach(() => {
    stopSpeech()
    cleanup()
  })

  it('starts playback after checking the local engine', async () => {
    const startSpy = vi.spyOn(await import('../../stores/speechPlayback'), 'startSpeech')
    render(<SpeechButton messageId="message-1" content="Explain this." />)

    fireEvent.click(screen.getByRole('button', { name: 'Read this response aloud' }))

    await waitFor(() => expect(api.prepareSpeech).toHaveBeenCalledWith('Explain this.', []))
    expect(startSpy).toHaveBeenCalledWith('message-1', ['Explain this.'])
  })

  it('opens guided installation when the engine is missing', async () => {
    api.getSpeechStatus.mockResolvedValue({ ...ready, state: 'not-installed', installed: false, progress: 0 })
    render(<SpeechButton messageId="message-2" content="Explain this." />)

    fireEvent.click(screen.getByRole('button', { name: 'Read this response aloud' }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install voice engine' }))
    await waitFor(() => expect(api.installSpeech).toHaveBeenCalled())
  })
})
