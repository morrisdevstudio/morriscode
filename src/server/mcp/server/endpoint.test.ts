// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMorrisCodeMcpRouter } from './endpoint.js'
import type { MorrisCodeMcpRouterOptions } from './endpoint.js'
import type { MorrisCodeMcpToolDeps } from './types.js'

const projects = [
  {
    id: 'p-1',
    name: 'proj',
    workdir: '/tmp/proj',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

function makeDeps(): MorrisCodeMcpToolDeps {
  return {
    sessionManager: {
      getSession: () => undefined,
      getProject: () => ({ id: 'p-1', name: 'proj', workdir: '/tmp/proj' }),
      createSession: vi.fn(),
      listSessionsByProject: vi.fn(() => ({ sessions: [], hasMore: false })),
      listSessionsLimited: vi.fn(() => ({ sessions: [], hasMore: false })),
      queueMessage: vi.fn(),
      getQueueState: vi.fn(() => []),
      getActiveWorkflowExecution: vi.fn(() => null),
      setPhase: vi.fn(),
    } as any,
    listProjects: vi.fn(() => projects),
    topLevelAgentIds: vi.fn(async () => []),
    listWorkflows: vi.fn(async () => []),
    launchWorkflow: vi.fn(),
    stopSession: vi.fn(),
    stopWorkflow: vi.fn(() => null),
    answerQuestion: vi.fn(() => false),
    pendingQuestions: vi.fn(() => []),
    confirmPath: vi.fn(() => false),
    pendingConfirmations: vi.fn(() => []),
    setMetadataEntries: vi.fn(),
    createProject: vi.fn(async () => ({
      id: 'p-2',
      name: 'x',
      workdir: '/tmp/x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    deleteProject: vi.fn(() => true),
    recentMessages: vi.fn(() => ({ messages: [], hiddenCount: 0 })),
  }
}

interface Started {
  url: string
  close: () => Promise<void>
}

function startRouter(options: MorrisCodeMcpRouterOptions): Promise<Started> {
  const app = express()
  app.use(express.json())
  app.use('/mcp', createMorrisCodeMcpRouter(options))
  const server = app.listen(0)
  return new Promise((resolve, reject) => {
    server.on('listening', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          }),
      })
    })
    server.on('error', reject)
  })
}

async function connectClient(url: string, headers?: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined)
  const client = new Client({ name: 'morriscode-mcp-endpoint-test', version: '0.0.1' })
  await client.connect(transport as any)
  return client
}

describe('morriscode MCP endpoint', () => {
  it('exposes the morriscode tool set to an MCP client (local mode, no auth)', async () => {
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => false,
      isAuthorized: vi.fn(async () => false),
    })

    try {
      const client = await connectClient(started.url)
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual(
        [
          'morriscode_answer',
          'morriscode_confirm',
          'morriscode_continue',
          'morriscode_create_project',
          'morriscode_create_session',
          'morriscode_delete_project',
          'morriscode_launch_workflow',
          'morriscode_projects',
          'morriscode_resume_workflow',
          'morriscode_send_message',
          'morriscode_session_detail',
          'morriscode_session_metadata',
          'morriscode_session_status',
          'morriscode_sessions',
          'morriscode_set_mode',
          'morriscode_stop',
          'morriscode_stop_workflow',
          'morriscode_wait',
          'morriscode_workflows',
        ].sort(),
      )

      const result = await client.callTool({ name: 'morriscode_projects', arguments: {} })
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
      expect(JSON.parse(text)).toHaveLength(1)
      expect(JSON.parse(text)[0]).toMatchObject({ id: 'p-1', name: 'proj' })
      await client.close()
    } finally {
      await started.close()
    }
  }, 30000)

  it('returns 401 when auth is required and no valid token is presented', async () => {
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => true,
      isAuthorized: vi.fn(async () => false),
    })

    try {
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      })
      expect(res.status).toBe(401)
      await started.close()
    } catch {
      await started.close()
      throw new Error('unreachable')
    }
  })

  it('accepts a valid token via x-session-token or Authorization: Bearer', async () => {
    const authorize = vi.fn(async (req: any) => {
      const token = req.headers['x-session-token'] ?? String(req.headers['authorization'] ?? '').replace(/^Bearer /, '')
      return token === 'sekrit'
    })
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => true,
      isAuthorized: authorize,
    })

    try {
      // x-session-token header: full MCP round-trip
      const client = await connectClient(started.url, { 'x-session-token': 'sekrit' })
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(19)
      await client.close()

      // Bearer header: initialize must not 401
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sekrit' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      })
      expect(res.status).not.toBe(401)
      await started.close()
    } catch (error) {
      await started.close()
      throw error
    }
  }, 30000)

  it('returns 503 when the tool dependencies are not ready yet', async () => {
    const started = await startRouter({
      resolveDeps: () => null,
      isAuthRequired: () => false,
      isAuthorized: vi.fn(async () => true),
    })

    try {
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      })
      expect(res.status).toBe(503)
      await started.close()
    } catch {
      await started.close()
      throw new Error('unreachable')
    }
  })

  it('leaves other routes untouched', async () => {
    const started = await startRouter({
      resolveDeps: () => makeDeps(),
      isAuthRequired: () => false,
      isAuthorized: vi.fn(async () => false),
    })

    try {
      const res = await fetch(started.url.replace('/mcp', '/api/health'))
      expect(res.status).toBe(404)
      await started.close()
    } catch {
      await started.close()
      throw new Error('unreachable')
    }
  })
})
