// Browser tests: the real site in Chrome against tests/e2e/server.mjs (real schema in PGlite).
import { defineConfig } from '@playwright/test';

const PORT = 5180;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs/,
  timeout: 45000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',          // the Chrome already installed on this machine
    headless: true,
    reducedMotion: 'reduce',    // numbers show their final value at once; motion has its own tests
    viewport: { width: 1200, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node tests/e2e/server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
