// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Project } from '@shared/types.js'

vi.mock('wouter', () => ({
  Redirect: ({ to }: { to: string }) => <div data-redirect={to} />,
}))

const projectsState = vi.hoisted(() => ({ projects: [] as Project[], loading: false }))
vi.mock('../hooks/useProjects', () => ({
  useProjects: () => projectsState,
}))

const sessionState = vi.hoisted(() => ({ connectionStatus: 'connected' }))
vi.mock('../stores/session', () => ({
  useSessionStore: (selector: (state: { connectionStatus: string }) => unknown) =>
    selector({ connectionStatus: sessionState.connectionStatus }),
}))

const tokenState = vi.hoisted(() => ({ hasToken: true }))
vi.mock('../lib/api', () => ({
  hasStoredToken: () => tokenState.hasToken,
}))

import { LAST_PROJECT_KEY } from '../lib/landing'
import { LandingRedirect } from './LandingRedirect'

function project(id: string, updatedAt: string): Project {
  return { id, name: id, workdir: `/tmp/${id}`, createdAt: updatedAt, updatedAt }
}

const projects = [project('recent', '2026-03-01'), project('older', '2026-01-01')]

function render(): HTMLElement {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(<LandingRedirect />)
  })
  return container
}

function redirectTarget(container: HTMLElement): string | null {
  return container.querySelector('[data-redirect]')?.getAttribute('data-redirect') ?? null
}

beforeEach(() => {
  localStorage.clear()
  projectsState.projects = projects
  projectsState.loading = false
  sessionState.connectionStatus = 'connected'
  tokenState.hasToken = true
})

describe('LandingRedirect', () => {
  it('opens the project the user last worked in', () => {
    localStorage.setItem(LAST_PROJECT_KEY, 'older')
    expect(redirectTarget(render())).toBe('/p/older')
  })

  it('opens the most recently updated project without a remembered one', () => {
    expect(redirectTarget(render())).toBe('/p/recent')
  })

  it('falls back to the split view when the user has no project yet', () => {
    projectsState.projects = []
    expect(redirectTarget(render())).toBe('/split-view')
  })

  it('waits for the projects before choosing a destination', () => {
    projectsState.projects = []
    projectsState.loading = true
    expect(redirectTarget(render())).toBeNull()
  })

  it('does not route an unauthenticated client', () => {
    sessionState.connectionStatus = 'disconnected'
    tokenState.hasToken = false
    expect(redirectTarget(render())).toBeNull()
  })
})
