import { Redirect } from 'wouter'
import { useProjects } from '../hooks/useProjects'
import { useSessionStore } from '../stores/session'
import { hasStoredToken } from '../lib/api'
import { SPLIT_ROUTE } from '../lib/splitPersistence'
import { readLastProjectId, resolveLandingProject } from '../lib/landing'
import { Spinner } from './shared/Spinner'

/**
 * The app root: open the project the user last worked in, sidebar and all,
 * instead of a launcher screen. A remembered project that no longer exists
 * falls back to the most recently updated one, and a user with no project yet
 * lands in the split view, where the header exposes the project menu.
 */
export function LandingRedirect() {
  const { projects, loaded, error } = useProjects()
  const connectionStatus = useSessionStore((state) => state.connectionStatus)
  const canLoad = connectionStatus === 'connected' || hasStoredToken()

  // The project list is empty until its fetch settles, so routing on the first
  // render would always redirect to the split view. Wait for an answer instead.
  if (!canLoad || (!loaded && !error)) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const lastProjectId = readLastProjectId()

  // A failed fetch (expired token, server restarting) says nothing about the
  // projects: trust the remembered one rather than dropping the user into the
  // split view. The project page retries its own data.
  if (!loaded) {
    return <Redirect to={lastProjectId ? `/p/${lastProjectId}` : SPLIT_ROUTE} />
  }

  const project = resolveLandingProject(projects, lastProjectId)
  return <Redirect to={project ? `/p/${project.id}` : SPLIT_ROUTE} />
}
