import { defineConfig, devices } from '@playwright/test';
import { findStack } from './supabase/tests/stack';

// A port of its own, so browser tests never collide with `pnpm dev`.
const PORT = 5199;

// A second site, built with accounts switched on and pointed at the local
// Supabase stack. It only exists when that stack is running (`pnpm db:start`);
// without it the account tests are skipped and say so.
export const ACCOUNT_PORT = 5198;
const ACCOUNT_BUILD = 'node_modules/.e2e-account';
const found = findStack();
const stack = 'missing' in found ? undefined : found;
process.env.TYPESHELF_E2E_STACK = stack ? JSON.stringify(stack) : '';
process.env.TYPESHELF_E2E_STACK_MISSING = 'missing' in found ? found.missing : '';

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
  webServer: [
    {
      command: `pnpm exec vite --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
      // The main site is always tested as a guest-only site, whatever `.env.local` says.
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    },
    ...(stack
      ? [
          {
            command: `pnpm exec vite build --outDir ${ACCOUNT_BUILD} --emptyOutDir && pnpm exec vite preview --outDir ${ACCOUNT_BUILD} --port ${ACCOUNT_PORT} --strictPort`,
            url: `http://localhost:${ACCOUNT_PORT}`,
            reuseExistingServer: false,
            env: { VITE_SUPABASE_URL: stack.url, VITE_SUPABASE_ANON_KEY: stack.anonKey },
          },
        ]
      : []),
  ],
});
