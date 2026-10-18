import type { Project } from '@shared/types.js'

/** LocalStorage key holding the project the user last worked in. */
export const LAST_PROJECT_KEY = 'morriscode:lastProject'

/** The project id this browser last worked in, if any. */
export function readLastProjectId(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(LAST_PROJECT_KEY)
}

/** Remember the project the user is working in — null forgets it. */
export function writeLastProjectId(projectId: string | null): void {
  if (typeof localStorage === 'undefined') return
  if (!projectId) {
    localStorage.removeItem(LAST_PROJECT_KEY)
    return
  }
  localStorage.setItem(LAST_PROJECT_KEY, projectId)
}

/**
 * Which project the app opens on. The project the user last worked in wins as
 * long as it still exists — a project deleted from another window must not send
 * the app back to a dead route. Otherwise the most recently updated project
 * (the server orders the list by updated_at DESC), or null when the user has no
 * project yet.
 */
export function resolveLandingProject(projects: Project[], lastProjectId: string | null): Project | null {
  if (lastProjectId) {
    const remembered = projects.find((project) => project.id === lastProjectId)
    if (remembered) return remembered
  }
  return projects[0] ?? null
}
