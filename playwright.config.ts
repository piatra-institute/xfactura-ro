import { defineConfig, devices } from '@playwright/test';

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535 (got "${raw}").`);
  }
  return port;
}

const web = readPort('XFACTURA_E2E_WEB_PORT', 3100);
const api = readPort('XFACTURA_E2E_API_PORT', 8189);
if (web === api) {
  throw new Error(`XFACTURA_E2E_WEB_PORT and XFACTURA_E2E_API_PORT must differ (both are ${web}).`);
}

export const e2ePorts = { web, api } as const;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: `http://localhost:${e2ePorts.web}`,
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
    url: `http://localhost:${e2ePorts.web}/contabilitate`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
