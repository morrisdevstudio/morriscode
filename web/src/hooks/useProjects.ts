import { useResource } from './useResource'
import { projectsResource } from '../lib/resources'

/**
 * All projects (global list) with implicit loadership via the projects resource
 * cache — no consumer needs to remember to fire a fetch.
 */
export function useProjects() {
  const { data, refresh, loading, error } = useResource(projectsResource)
  const projects = data?.projects ?? []
  // `loaded` distinguishes "the server answered with no projects" from the
  // first render, before the request has even started.
  return { projects, refresh, loading, error, loaded: data !== undefined }
}
