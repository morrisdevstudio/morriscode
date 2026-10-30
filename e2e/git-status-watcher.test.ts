import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createTestClient,
  createTestProject,
  createTestServer,
  createProject,
  createSession,
  type TestClient,
  type TestProject,
  type TestServerHandle,
} from './utils/index.js'
import type { GitStatusPayload, GitDiffFile } from '@morriscode/shared/protocol'

// Hooks (e.g. Husky) export GIT_DIR/GIT_INDEX_FILE for the repo being committed.
// The fixture repos must resolve their own .git, or git commands silently target
// the parent repository instead.
const fixtureGitEnv = { ...process.env }
delete fixtureGitEnv['GIT_DIR']
delete fixtureGitEnv['GIT_INDEX_FILE']
delete fixtureGitEnv['GIT_WORK_TREE']
delete fixtureGitEnv['GIT_PREFIX']

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: fixtureGitEnv })
}

/**
 * Wait for a git.status event matching the expected working-tree state.
 *
 * The server polls on an interval, and a busy machine can delay a poll well
 * past a fixed sleep. Waiting for the event itself keeps the test stable
 * without hiding a genuine detection failure.
 */
async function waitForGitStatus(
  client: TestClient,
  predicate: (payload: GitStatusPayload) => boolean,
  timeout = 8_000,
): Promise<GitStatusPayload> {
  const message = await client.waitFor<GitStatusPayload>('git.status', predicate, timeout)
  return message.payload
}

describe('Git Status Watcher', () => {
  let server: TestServerHandle
  let client: TestClient
  let project: TestProject

  beforeAll(async () => {
    process.env['MORRISCODE_GIT_POLL_INTERVAL'] = '1000'
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    client = await createTestClient({ url: server.wsUrl, timeout: 20_000 })
    project = await createTestProject({ template: 'git-repo' })
  })

  afterEach(async () => {
    await client.close()
    await project.cleanup()
  })

  it('updates git status after file modification via polling', async () => {
    const restProject = await createProject(server.url, { name: 'test', workdir: project.path })
    const restSession = await createSession(server.url, { projectId: restProject.id })

    await client.send('session.load', { sessionId: restSession.id })

    const initialMsg = await client.waitFor<GitStatusPayload>('git.status', undefined, 3000)
    expect(initialMsg.type).toBe('git.status')
    const initialPayload = initialMsg.payload as GitStatusPayload
    expect(initialPayload.diff.files).toHaveLength(0)

    const testFilePath = join(project.path, 'src', 'index.ts')
    await writeFile(testFilePath, '// Modified by test\n')

    const updatePayload = await waitForGitStatus(client, (payload) =>
      payload.diff.files.some((file) => file.path.includes('src/index.ts') && file.status === 'modified'),
    )
    const modifiedFiles = updatePayload.diff.files.filter((f: GitDiffFile) => f.path.includes('src/index.ts'))
    expect(modifiedFiles.length).toBe(1)
    expect(modifiedFiles[0]!.status).toBe('modified')
  }, 10_000)

  it('reports submodule changes when the submodule has untracked-only modifications', async () => {
    const subDir = join(tmpdir(), `morriscode-submodule-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await mkdir(subDir, { recursive: true })
      runGit(subDir, ['init', '--initial-branch=main'])
      runGit(subDir, ['config', 'user.email', 'test@example.com'])
      runGit(subDir, ['config', 'user.name', 'Test User'])
      await writeFile(join(subDir, 'hello.txt'), 'hello\n')
      runGit(subDir, ['add', '.'])
      runGit(subDir, ['commit', '-m', 'initial'])

      runGit(project.path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subDir, 'libs/mod'])
      runGit(project.path, ['commit', '-am', 'add submodule'])

      const restProject = await createProject(server.url, { name: 'test', workdir: project.path })
      const restSession = await createSession(server.url, { projectId: restProject.id })
      await client.send('session.load', { sessionId: restSession.id })
      await client.waitFor<GitStatusPayload>('git.status', undefined, 3000)

      // Untracked-only change inside the submodule — invisible to `git diff --name-status` by default
      await writeFile(join(project.path, 'libs', 'mod', 'generated.txt'), 'generated\n')

      const updatePayload = await waitForGitStatus(client, (payload) =>
        payload.diff.files.some((file) => file.path.includes('libs/mod') && file.status === 'modified'),
      )
      const submoduleFiles = updatePayload.diff.files.filter((f: GitDiffFile) => f.path.includes('libs/mod'))
      expect(submoduleFiles.length).toBe(1)
      expect(submoduleFiles[0]!.status).toBe('modified')
    } finally {
      await rm(subDir, { recursive: true, force: true })
    }
  }, 15_000)
})
