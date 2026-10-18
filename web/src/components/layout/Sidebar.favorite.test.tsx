// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { Sidebar } from './Sidebar'
import type { SessionSummary } from '@shared/types.js'
import { formatTime } from '../../lib/format-date'

const mockNavigate = vi.fn()
const mockToggleFavorite = vi.fn()
const mockToggleStar = vi.fn()

vi.mock('../../stores/project', () => ({
  useProjectStore: (selector: any) => selector({ toggleStar: mockToggleStar }),
}))

vi.mock('../../hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [
      { id: 'project-1', name: 'Alpha project', isStarred: false },
      { id: 'project-2', name: 'Beta project', isStarred: true },
    ],
  }),
}))

vi.mock('wouter', () => ({
  useLocation: () => [undefined, mockNavigate],
  Link: ({ children, href, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

const sessionStoreState = {
  sessions: [] as SessionSummary[],
  currentSession: null as { id: string } | null,
  unreadSessionIds: [],
  sessionsWithPendingConfirmations: [],
  pendingPathConfirmations: [],
  sessionsHasMore: false,
  sessionsPaginationLoading: false,
  listSessions: vi.fn(),
  loadMoreSessions: vi.fn(),
  deleteSession: vi.fn(),
  deleteAllSessions: vi.fn(),
  renameSession: vi.fn(),
  toggleFavorite: mockToggleFavorite,
}

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}))

vi.mock('../../hooks/useCurrentProject', () => ({
  useCurrentProject: () => ({ id: 'project-1', name: 'Project', workdir: '/tmp/project' }),
}))

vi.mock('../settings/ProjectSettingsModal', () => ({
  ProjectSettingsModal: () => null,
}))

vi.mock('../shared/ConfirmModal', () => ({
  ConfirmModal: () => null,
}))

vi.mock('../shared/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div data-testid="modal">{children}</div>,
}))

vi.mock('../shared/ModalFooter', () => ({
  ModalFooter: () => null,
}))

vi.mock('../shared/CloseButton', () => ({
  CloseButton: () => <button data-testid="close-button">X</button>,
}))

vi.mock('../shared/Button', () => ({
  Button: ({ children, onClick, className }: any) => (
    <button className={className} onClick={onClick}>
      {children}
    </button>
  ),
}))

vi.mock('../shared/icons', async (importOriginal) => ({
  // Real icons by default so new icons never break the mock; the stubs below
  // keep the test-friendly markers the assertions rely on.
  ...(await importOriginal<typeof import('../shared/icons')>()),
  EllipsisIcon: () => <span data-testid="ellipsis-icon">...</span>,
  SpinIcon: () => <span data-testid="spin-icon" />,
  StopIcon: () => <span data-testid="stop-icon" />,
  SearchIcon: () => <span data-testid="search-icon">🔍</span>,
  XCloseIcon: () => <span data-testid="xclose-icon">✕</span>,
  StarIcon: () => <span data-testid="star-icon">☆</span>,
  StarFilledIcon: () => <span data-testid="star-filled-icon">★</span>,
  DownloadIcon: () => <span data-testid="download-icon" />,
  UploadIcon: () => <span data-testid="upload-icon" />,
  GearIcon: () => <span data-testid="gear-icon" />,
  TrashIcon: () => <span data-testid="trash-icon" />,
  EditSmallIcon: () => <span data-testid="edit-small-icon" />,
}))

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    projectId: 'project-1',
    title: 'Untitled',
    workdir: '/tmp/project',
    mode: 'planner',
    phase: 'plan',
    isRunning: false,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-01T10:00:00Z',
    isFavorite: false,
    criteriaCount: 0,
    criteriaCompleted: 0,
    messageCount: 0,
    ...overrides,
  }
}

function renderSidebar(): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Sidebar projectId="project-1" />)
  })
  return container
}

function click(node: Element | null | undefined) {
  if (!node) throw new Error('Expected click target to exist')
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function findOptionsButton(sessionTitle: string): HTMLElement | null {
  const links = Array.from(document.querySelectorAll('a[href^="/p/"]'))
  const link = links.find((l) => l.textContent?.includes(sessionTitle))
  return link?.querySelector('button[title="Options"]') ?? null
}

function findMenu(): HTMLElement | null {
  return document.querySelector('[data-testid="session-dropdown-menu"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  sessionStoreState.sessions = []
  sessionStoreState.currentSession = null
})

describe('Sidebar favorites', () => {
  it('only highlights the active conversation when search is not focused', () => {
    sessionStoreState.sessions = [
      session({ id: 'session-1', title: 'First' }),
      session({ id: 'session-2', title: 'Second' }),
      session({ id: 'session-3', title: 'Third' }),
    ]
    sessionStoreState.currentSession = { id: 'session-3' }
    const container = renderSidebar()
    expect(container.querySelectorAll('[data-sidx].bg-accent-primary\\/10')).toHaveLength(0)
    const activeRows = container.querySelectorAll('[data-sidx].bg-bg-tertiary')
    expect(activeRows).toHaveLength(1)
    expect(activeRows[0]?.textContent).toContain('Third')
  })

  it('clears the search keyboard highlight as soon as focus leaves the search field', () => {
    sessionStoreState.sessions = [
      session({ id: 'session-1', title: 'First' }),
      session({ id: 'session-2', title: 'Second' }),
    ]
    const container = renderSidebar()
    const search = container.querySelector('input[placeholder="Search sessions..."]') as HTMLInputElement
    act(() => search.focus())
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(container.querySelectorAll('[data-sidx].bg-accent-primary\\/10')).toHaveLength(1)
    act(() => search.blur())
    expect(container.querySelectorAll('[data-sidx].bg-accent-primary\\/10')).toHaveLength(0)
  })

  it('does not render a standalone star button in session rows', () => {
    sessionStoreState.sessions = [session({ id: 'session-1', title: 'Alpha' })]
    renderSidebar()

    const stars = document.querySelectorAll('button[title="Add to favorites"], button[title="Remove from favorites"]')
    expect(stars.length).toBe(0)
  })

  it('opens the options menu which contains the favorite toggle', () => {
    sessionStoreState.sessions = [session({ id: 'session-1', title: 'Alpha' })]
    renderSidebar()

    click(findOptionsButton('Alpha'))

    const menu = findMenu()
    expect(menu).toBeTruthy()
    expect(menu?.textContent).toContain('Add to favorites')
  })

  it('unfavorites a favorite session from the options menu without navigating', () => {
    sessionStoreState.sessions = [
      session({ id: 'session-1', title: 'Alpha' }),
      session({ id: 'session-2', title: 'Beta', isFavorite: true }),
    ]
    renderSidebar()

    click(findOptionsButton('Beta'))
    const menu = findMenu()
    expect(menu?.textContent).toContain('Remove from favorites')

    const item = Array.from(menu?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Remove from favorites'),
    )
    click(item)

    expect(mockToggleFavorite).toHaveBeenCalledWith('session-2', false)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('favorites a non-favorite session from the options menu', () => {
    sessionStoreState.sessions = [session({ id: 'session-1', title: 'Alpha' })]
    renderSidebar()

    click(findOptionsButton('Alpha'))
    const menu = findMenu()
    const item = Array.from(menu?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Add to favorites'),
    )
    click(item)

    expect(mockToggleFavorite).toHaveBeenCalledWith('session-1', true)
  })

  it('hides time and message count for every session', () => {
    sessionStoreState.sessions = [
      session({ id: 'session-1', title: 'Alpha', updatedAt: '2026-08-01T10:00:00Z' }),
      session({ id: 'session-2', title: 'Beta', updatedAt: '2026-08-01T11:00:00Z', isFavorite: true }),
    ]
    renderSidebar()

    const links = Array.from(document.querySelectorAll('a[href^="/p/"]'))
    const alphaLink = links.find((l) => l.textContent?.includes('Alpha'))
    const betaLink = links.find((l) => l.textContent?.includes('Beta'))

    expect(alphaLink?.textContent).not.toContain(formatTime('2026-08-01T10:00:00Z'))
    expect(betaLink?.textContent).not.toContain(formatTime('2026-08-01T11:00:00Z'))
    expect(alphaLink?.textContent).not.toContain('messages')
    expect(betaLink?.textContent).not.toContain('messages')
  })

  it('offers a new session in each project even with no sessions', () => {
    renderSidebar()
    expect(document.querySelector('a[href="/p/project-2/new"]')).toBeTruthy()
    expect(document.querySelector('a[href="/p/project-1/new"]')).toBeTruthy()
  })

  it('toggles project favorites without collapsing or navigating', () => {
    sessionStoreState.sessions = [session({ id: 'session-1', title: 'Alpha' })]
    renderSidebar()
    click(document.querySelector('button[title="Favorite project"]'))
    expect(mockToggleStar).toHaveBeenCalledWith('project-1', true)
    click(document.querySelector('button[title="Unfavorite project"]'))
    expect(mockToggleStar).toHaveBeenCalledWith('project-2', false)
    expect(document.querySelector('button[title="Alpha project"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('places favorite projects first', () => {
    sessionStoreState.sessions = [session({ id: 'session-1' })]
    renderSidebar()
    const projectButtons = document.querySelectorAll('button[aria-expanded]')
    expect(projectButtons[0]?.getAttribute('title')).toBe('Beta project')
  })
})
