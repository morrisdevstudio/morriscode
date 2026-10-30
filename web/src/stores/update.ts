import { create } from 'zustand'
// Authorized exception: update check is an explicit one-shot poll with a local result, not shared server data.
import { appUrl } from '../lib/basePath'
import { authFetch } from '../lib/api'

type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'applying' | 'error'

type InstallFlavor = 'release' | 'npm' | 'development'

interface UpdatePayload {
  current?: string
  latest?: string
  phase?: string
  updateAvailable?: boolean
  isUpdateAvailable?: boolean
  autoUpdate?: boolean
  received?: number
  total?: number
  error?: string | null
  stagedVersion?: string | null
  releaseUrl?: string | null
  notes?: string | null
  lastApplied?: string | null
  flavor?: InstallFlavor
}

interface UpdateState {
  status: UpdateStatus
  current: string | null
  latest: string | null
  stagedVersion: string | null
  phase: string | null
  autoUpdate: boolean
  received: number
  total: number
  error: string | null
  releaseUrl: string | null
  notes: string | null
  flavor: InstallFlavor | null
  check: (force?: boolean) => Promise<void>
  refresh: () => Promise<void>
  apply: () => Promise<{ success: boolean; version?: string; error?: string; restarting?: boolean }>
  setAutoUpdate: (enabled: boolean) => Promise<void>
}

function statusFromPayload(data: UpdatePayload): UpdateStatus {
  if (data.phase === 'error') return 'error'
  if (data.phase === 'downloading') return 'downloading'
  if (data.phase === 'applying') return 'applying'
  if (data.phase === 'ready') return 'ready'
  if (data.isUpdateAvailable ?? data.updateAvailable) return 'available'
  return 'upToDate'
}

function mergePayload(state: UpdateState, data: UpdatePayload): Partial<UpdateState> {
  return {
    status: statusFromPayload(data),
    current: data.current ?? state.current,
    latest: data.latest ?? state.latest,
    stagedVersion: data.stagedVersion ?? null,
    phase: data.phase ?? null,
    autoUpdate: data.autoUpdate ?? state.autoUpdate,
    received: data.received ?? 0,
    total: data.total ?? 0,
    error: data.error ?? null,
    releaseUrl: data.releaseUrl ?? state.releaseUrl,
    notes: data.notes ?? state.notes,
    flavor: data.flavor ?? state.flavor,
  }
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  current: null,
  latest: null,
  stagedVersion: null,
  phase: null,
  autoUpdate: true,
  received: 0,
  total: 0,
  error: null,
  releaseUrl: null,
  notes: null,
  flavor: null,

  check: async (force?: boolean) => {
    if (!force && get().status === 'checking') return
    set({ status: 'checking' })
    try {
      const res = await fetch(appUrl(`/api/auto-update/check${force ? '?force=true' : ''}`))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as UpdatePayload
      set((state) => mergePayload(state, data))
    } catch {
      set({ status: 'error', error: null })
    }
  },

  refresh: async () => {
    try {
      const res = await authFetch('/api/auto-update/status')
      if (!res.ok) return
      const data = (await res.json()) as UpdatePayload
      if (!data.phase && !data.current) return
      set((state) => mergePayload(state, data))
    } catch {
      // A restart may briefly make the status endpoint unreachable.
    }
  },

  apply: async () => {
    const res = await authFetch('/api/auto-update', { method: 'POST' })
    return (await res.json()) as { success: boolean; version?: string; error?: string; restarting?: boolean }
  },

  setAutoUpdate: async (enabled: boolean) => {
    const res = await authFetch('/api/auto-update/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoUpdate: enabled }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { autoUpdate?: boolean }
    set({ autoUpdate: data.autoUpdate ?? enabled })
  },
}))
