import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: resolve(__dirname),
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  globalSetup: resolve(__dirname, 'setup/global-setup.ts'),
  use: {
    baseURL: 'http://127.0.0.1:10669',
    trace: 'on-first-retry',
    browserName: 'chromium',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // cross-env keeps the inline environment portable to Windows shells.
    command: 'cross-env MORRISCODE_PORT=10669 MORRISCODE_DB_PATH=:memory: MORRISCODE_MOCK_LLM=true npm run dev',
    url: 'http://127.0.0.1:10669',
    reuseExistingServer: !process.env.CI,
    // The dev server compiles the web app through Vite before it accepts
    // connections, which easily exceeds the 60s default on a cold start.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
