// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { LAST_PROJECT_KEY, readLastProjectId, resolveLandingProject, writeLastProjectId } from './landing'
import type { Project } from '@shared/types.js'

function project(id: string, updatedAt: string): Project {
  return { id, name: id, workdir: `/tmp/${id}`, createdAt: updatedAt, updatedAt }
}

const projects = [project('recent', '2026-03-01'), project('older', '2026-01-01')]

describe('resolveLandingProject', () => {
  it('opens the project the user last worked in', () => {
    expect(resolveLandingProject(projects, 'older')?.id).toBe('older')
  })

  it('falls back to the most recently updated project without a remembered one', () => {
    expect(resolveLandingProject(projects, null)?.id).toBe('recent')
  })

  it('ignores a remembered project that no longer exists', () => {
    expect(resolveLandingProject(projects, 'deleted-project')?.id).toBe('recent')
  })

  it('returns null when the user has no project yet', () => {
    expect(resolveLandingProject([], null)).toBeNull()
    expect(resolveLandingProject([], 'deleted-project')).toBeNull()
  })
})

describe('last project persistence', () => {
  beforeEach(() => localStorage.clear())

  it('remembers the project id and forgets it on request', () => {
    writeLastProjectId('proj-a')
    expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe('proj-a')
    expect(readLastProjectId()).toBe('proj-a')

    writeLastProjectId(null)
    expect(readLastProjectId()).toBeNull()
  })
})
