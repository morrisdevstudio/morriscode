/** @vitest-environment happy-dom */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NetworkAccessCard } from './NetworkAccessCard'
import { configResource, type ServerNetworkInfo } from '../../lib/resources'
import { clearCache } from '../../lib/resourceCache'
import { authFetch } from '../../lib/api'

vi.mock('../../lib/api', () => ({ authFetch: vi.fn() }))

const LAN_NETWORK: ServerNetworkInfo = {
  host: '0.0.0.0',
  port: 10369,
  https: true,
  urls: ['https://192.168.1.23:10369'],
  certificatePath: 'C:/cfg/certs/server.crt',
  certificateGenerated: true,
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response
}

function seed(serverNetwork: ServerNetworkInfo): void {
  configResource.write({
    version: '2.0.0',
    model: null,
    maxContext: 200000,
    llmUrl: null,
    llmStatus: 'unknown',
    backend: 'unknown',
    defaultModelSelection: null,
    platform: null,
    workdir: null,
    visionFallback: null,
    locale: 'automatic',
    serverNetwork,
  })
}

/**
 * Stand-in for the server: GET answers with the current settings, PUT answers with
 * those settings plus the change, which is what the card writes back into the cache.
 */
function mockServer(network: ServerNetworkInfo): void {
  vi.mocked(authFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/config/network') {
      const patch = init?.body ? (JSON.parse(String(init.body)) as Partial<ServerNetworkInfo>) : {}
      return jsonResponse({ restartRequired: true, serverNetwork: { ...network, ...patch } })
    }
    return jsonResponse({ version: '2.0.0', serverNetwork: network })
  })
}

function toggleFor(container: HTMLElement, label: string): HTMLLabelElement {
  const toggle = Array.from(container.querySelectorAll('label')).find((element) => element.textContent?.includes(label))
  expect(toggle).toBeTruthy()
  return toggle as HTMLLabelElement
}

describe('NetworkAccessCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
  })

  it('shows the URLs another device should open, plus the certificate in use', async () => {
    seed(LAN_NETWORK)
    mockServer(LAN_NETWORK)
    render(<NetworkAccessCard />)

    expect(await screen.findByText('https://192.168.1.23:10369')).toBeInTheDocument()
    expect(screen.getByText('C:/cfg/certs/server.crt')).toBeInTheDocument()
    expect(screen.queryByText('Restart MorrisCode to apply.')).toBeNull()
  })

  it('renders nothing when the server does not report network settings', async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse({ version: '1.0.0' }))
    const { container } = render(<NetworkAccessCard />)
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/config'))
    expect(container.querySelector('h3')).toBeNull()
  })

  it('binds back to localhost when LAN access is switched off', async () => {
    seed(LAN_NETWORK)
    mockServer(LAN_NETWORK)
    const { container } = render(<NetworkAccessCard />)
    await screen.findByText('https://192.168.1.23:10369')

    await userEvent.setup().click(toggleFor(container, 'Reachable from the local network'))

    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/config/network', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1' }),
      }),
    )
    expect(await screen.findByText('Restart MorrisCode to apply.')).toBeInTheDocument()
    expect(screen.queryByText('https://192.168.1.23:10369')).toBeNull()
  })

  it('turns HTTPS on and says a restart is needed before it applies', async () => {
    const plain: ServerNetworkInfo = {
      ...LAN_NETWORK,
      https: false,
      certificatePath: null,
      certificateGenerated: false,
    }
    seed(plain)
    mockServer(plain)
    const { container } = render(<NetworkAccessCard />)
    await screen.findByText('https://192.168.1.23:10369')

    await userEvent.setup().click(toggleFor(container, 'HTTPS'))

    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/config/network', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ https: true }),
      }),
    )
    expect(await screen.findByText('Restart MorrisCode to apply.')).toBeInTheDocument()
  })
})
