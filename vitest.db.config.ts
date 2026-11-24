import { defineConfig } from 'vitest/config';

// Database tests: they talk to the local Supabase stack (`pnpm db:start`),
// so they are kept out of the plain `pnpm test` run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['supabase/tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // One file at a time: the tests share one database.
    fileParallelism: false,
  },
});
