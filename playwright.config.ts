import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    channel: process.platform === 'darwin' ? 'chrome' : undefined,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'bun run scripts/e2e-server.ts',
    url: 'http://localhost:3100/contabilitate',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
