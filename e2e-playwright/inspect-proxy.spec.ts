import { test, expect } from '@playwright/test'
import http from 'http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SERVER_URL = process.env['MORRISCODE_E2E_SERVER_URL'] || 'http://localhost:10669'

interface TestContext {
  projectId: string
  sessionId: string
  workdir: string
  devServerPort: number
  devServer: http.Server
  authToken: string
  cleanup: () => Promise<void>
}

async function apiFetch(path: string, options: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) headers['x-session-token'] = options.token
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: { ...headers, ...((options.headers as Record<string, string>) || {}) },
  })
  if (!res.ok) throw new Error(`API ${options.method || 'GET'} ${path} failed: ${await res.text()}`)
  return res.json()
}

async function setupTest(): Promise<TestContext> {
  const timestamp = Date.now()
  const workdir = join(tmpdir(), `morriscode-inspect-e2e-${timestamp}`)
  await mkdir(workdir, { recursive: true })
  await mkdir(join(workdir, '.morriscode'), { recursive: true })

  // Login to get auth token
  const loginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'password' }),
  })
  if (!loginRes.ok) throw new Error(`Login failed: ${await loginRes.text()}`)
  const { token } = await loginRes.json()
  const authToken: string = token

  const authHeaders = { 'x-session-token': authToken, 'Content-Type': 'application/json' }

  // Create project
  const projectData: any = await apiFetch('/api/projects', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Inspect E2E Test', workdir }),
    token: authToken,
  })
  const projectId: string = projectData.project.id

  // Create session
  const sessionData: any = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ projectId, title: 'Inspect Test Session' }),
    token: authToken,
  })
  const sessionId: string = sessionData.session.id

  // Start a minimal dev server
  const devServerPort = 18765 + (timestamp % 1000)
  const devServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body><h1>Dev Server</h1><p>Test content</p></body></html>')
  })
  await new Promise<void>((resolve) => devServer.listen(devServerPort, '127.0.0.1', resolve))

  // Write dev config (filename depends on mode: dev-dev.json for development, dev.json for production)
  const configFilename = 'dev-dev.json'
  const devConfig = {
    command: `echo "mock dev server on ${devServerPort}"`,
    url: `http://127.0.0.1:${devServerPort}`,
    hotReload: false,
    disableInspect: false,
  }
  await writeFile(join(workdir, '.morriscode', configFilename), JSON.stringify(devConfig, null, 2) + '\n')

  const cleanup = async () => {
    devServer.close()
    try {
      const { rm } = await import('node:fs/promises')
      await rm(workdir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  return { projectId, sessionId, workdir, devServerPort, devServer, authToken, cleanup }
}

test.describe('Inspect Proxy E2E', () => {
  let ctx: TestContext

  test.beforeAll(async () => {
    test.setTimeout(60_000)
    ctx = await setupTest()
  })

  test.afterAll(async () => {
    await ctx.cleanup()
  })

  test('widget loads, shows session picker, and sends feedback', async ({ page }) => {
    test.setTimeout(60_000)

    // Start the dev server via API (this also starts the inspect proxy)
    const startRes = await fetch(`${SERVER_URL}/api/dev-server/start?workdir=${encodeURIComponent(ctx.workdir)}`, {
      method: 'POST',
      headers: { 'x-session-token': ctx.authToken },
    })
    expect(startRes.ok).toBeTruthy()
    const status = await startRes.json()
    expect(status.inspectProxyPort).toBeGreaterThan(0)

    const proxyPort: number = status.inspectProxyPort

    // Navigate to the dev server through the proxy
    await page.goto(`http://127.0.0.1:${proxyPort}/`)
    await page.waitForLoadState('networkidle')

    // Verify the widget overlay is present
    const overlay = page.locator('#__fox-overlay')
    await expect(overlay).toBeVisible({ timeout: 5000 })

    // Click "Send feedback" to enter inspect mode
    const toggleBtn = page.locator('#__fox-toggle')
    await toggleBtn.click()

    // Verify we're in inspect mode
    await expect(toggleBtn).toHaveText('Exit inspect')

    // Click on the h1 element to inspect it
    const heading = page.locator('h1')
    await heading.click()

    // The feedback popup should appear
    const popup = page.locator('#__fox-popup')
    await expect(popup).toBeVisible({ timeout: 3000 })

    // Verify the popup shows the element info
    await expect(popup.locator('.__fox-tag')).toContainText('h1')

    // Verify the session picker is inside the popup
    const sessionPicker = popup.locator('#__fox-popup-session-picker')
    await expect(sessionPicker).toBeVisible()

    // Wait for sessions to load (picker should have more than just the default option)
    await expect(sessionPicker.locator('option')).toHaveCount(2, { timeout: 5000 })

    // Select our test session
    await sessionPicker.selectOption(ctx.sessionId)
    const selectedValue = await sessionPicker.inputValue()
    expect(selectedValue).toBe(ctx.sessionId)

    // Type feedback
    const textarea = popup.locator('#__fox-feedback-textarea')
    await textarea.fill('This heading looks great!')

    // Send the feedback
    const sendBtn = popup.locator('.__fox-send')
    await sendBtn.click()

    // Wait for the popup to disappear
    await expect(popup).not.toBeVisible({ timeout: 3000 })

    // Verify we're back to normal mode
    await expect(toggleBtn).toHaveText('Send feedback')

    // Verify the message was queued in the session — poll API until it appears
    await expect(async () => {
      const sessionData: any = await apiFetch(`/api/sessions/${ctx.sessionId}`, {
        headers: { 'x-session-token': ctx.authToken },
        token: ctx.authToken,
      })
      const feedbackMsg = sessionData.messages?.find(
        (m: any) => m.messageKind === 'ui_feedback' || m.content?.includes('heading looks great'),
      )
      expect(feedbackMsg).toBeTruthy()
      expect(feedbackMsg.content).toContain('heading looks great')
    }).toPass({ timeout: 10000, intervals: [1000] })

    // Stop the dev server
    await fetch(`${SERVER_URL}/api/dev-server/stop?workdir=${encodeURIComponent(ctx.workdir)}`, {
      method: 'POST',
      headers: { 'x-session-token': ctx.authToken },
    })
  })
})
