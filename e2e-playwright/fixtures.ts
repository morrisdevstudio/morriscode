import { test as base } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestFixtures {
  projectId: string
  serverUrl: string
}

async function readConfig() {
  const tempFile = join(tmpdir(), 'morriscode-test-project-id.json')
  const content = await readFile(tempFile, 'utf-8')
  return JSON.parse(content) as { projectId: string; serverUrl: string; workdir: string }
}

async function writeConfig(data: { projectId: string; serverUrl: string; workdir: string }) {
  const tempFile = join(tmpdir(), 'morriscode-test-project-id.json')
  await writeFile(tempFile, JSON.stringify(data))
}

export const test = base.extend<TestFixtures>({
  projectId: async ({}, use) => {
    const config = await readConfig()
    if (config.projectId === '__to_be_created__') {
      // Create project via REST API
      const res = await fetch(`${config.serverUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Playwright Test Project', workdir: config.workdir }),
      })
      if (!res.ok) throw new Error(`Failed to create project: ${await res.text()}`)
      const data = await res.json()
      config.projectId = data.project.id
      await writeConfig(config)
    }
    await use(config.projectId)
  },
  serverUrl: async ({}, use) => {
    const config = await readConfig()
    await use(config.serverUrl)
  },
})

export { expect } from '@playwright/test'

// Re-export page objects for convenience
export { SessionSidebar } from './page-objects/SessionSidebar.js'
export { SessionHeader } from './page-objects/SessionHeader.js'
