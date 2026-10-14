/**
 * Workflow User-Choice Branching E2E Tests
 *
 * Verifies that a user step with step_result transitions presents choice
 * buttons (pendingChoices), and that resuming with a userChoice routes the
 * workflow to the matching branch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createTestClient,
  createTestProject,
  createTestServer,
  createProject,
  createSession,
  collectUntil,
  assertNoErrors,
  type TestClient,
  type TestProject,
  type TestServerHandle,
} from './utils/index.js'

const WORKFLOW = {
  metadata: { id: 'choices', name: 'Choices', description: 'User-choice branching test', version: '1' },
  entryStep: 'choose',
  settings: { maxIterations: 10 },
  steps: [
    {
      id: 'choose',
      name: 'Choose Path',
      type: 'user',
      phase: 'verification',
      transitions: [
        { when: { type: 'step_result', result: 'apply' }, goto: 'applied' },
        { when: { type: 'step_result', result: 'skip' }, goto: 'skipped' },
        { when: { type: 'always' }, goto: 'applied' },
      ],
    },
    {
      id: 'applied',
      name: 'Applied',
      type: 'shell',
      phase: 'build',
      command: 'echo APPLIED_MARKER',
      transitions: [{ when: { type: 'always' }, goto: '$done' }],
    },
    {
      id: 'skipped',
      name: 'Skipped',
      type: 'shell',
      phase: 'build',
      command: 'echo SKIPPED_MARKER',
      transitions: [{ when: { type: 'always' }, goto: '$done' }],
    },
  ],
}

describe('Workflow User-Choice Branching', () => {
  let server: TestServerHandle
  let client: TestClient
  let testDir: TestProject

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    testDir = await createTestProject({ template: 'typescript' })
    await mkdir(join(testDir.path, '.morriscode', 'workflows'), { recursive: true })
    await writeFile(
      join(testDir.path, '.morriscode', 'workflows', 'choices.workflow.json'),
      JSON.stringify(WORKFLOW, null, 2),
    )
    client = await createTestClient({ url: server.wsUrl })
  })

  afterEach(async () => {
    await client.close()
    await testDir.cleanup()
  })

  it('presents pendingChoices at a user step and routes on userChoice', async () => {
    const project = await createProject(server.url, { name: 'Choices', workdir: testDir.path })
    const session = await createSession(server.url, { projectId: project.id })
    await client.send('session.load', { sessionId: session.id })

    // Launch the workflow — should pause immediately at the 'choose' user step
    await client.send('runner.launch', { workflowId: 'choices' })

    const waitingEvents = await collectUntil(
      client,
      (event) =>
        event.type === 'workflow.execution_changed' && (event.payload as { status: string }).status === 'waiting',
    )
    assertNoErrors(waitingEvents)

    const waiting = waitingEvents.findEvent(
      (event) =>
        event.type === 'workflow.execution_changed' && (event.payload as { status: string }).status === 'waiting',
    )
    const waitingPayload = waiting!.payload as {
      currentStepId: string
      pendingChoices?: Array<{ id: string; label: string; goto: string; nextStepName?: string }>
    }
    expect(waitingPayload.currentStepId).toBe('choose')
    expect(waitingPayload.pendingChoices).toEqual([
      { id: 'apply', label: 'apply', goto: 'applied', nextStepName: 'Applied' },
      { id: 'skip', label: 'skip', goto: 'skipped', nextStepName: 'Skipped' },
      { id: 'continue', label: 'Continue', goto: 'applied', nextStepName: 'Applied' },
    ])

    // Resume with the 'skip' choice — should run the 'skipped' shell step only
    await client.send('runner.launch', { workflowId: 'choices', resumeFrom: 'choose', userChoice: 'skip' })

    const doneEvents = await collectUntil(
      client,
      (event) =>
        event.type === 'workflow.execution_changed' && (event.payload as { status: string }).status === 'completed',
    )
    assertNoErrors(doneEvents)

    const markers = doneEvents.all
      .filter((e) => e.type === 'chat.message')
      .map((e) => (e.payload as { message?: { content?: string } }).message?.content ?? '')
      .join('\n')
    expect(markers).toContain('SKIPPED_MARKER')
    expect(markers).not.toContain('APPLIED_MARKER')
  })
})
