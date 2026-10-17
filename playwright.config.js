import { defineConfig } from '@playwright/test';
const port = Number(process.env.AGENTBL_BROWSER_PORT ?? 4187);
export default defineConfig({
  testDir: './tests/browser', workers: 1, fullyParallel: false, timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'test-results/browser.json' }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.AGENTBL_CHROMIUM_PATH ? { executablePath: process.env.AGENTBL_CHROMIUM_PATH } : {} },
  webServer: { command: 'node scripts/browser-server.mjs', url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 30000 }
});
