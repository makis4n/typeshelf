import { defineConfig, devices } from '@playwright/test';

// A port of its own, so browser tests never collide with `pnpm dev`.
const PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    // Uses the Chrome already installed on this machine, so there is no browser download.
    channel: 'chrome',
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
  },
});
