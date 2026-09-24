import { defineConfig } from '@playwright/test';

// E2E runs the built extension against local fixtures only (never live sites).
// `pnpm test:e2e` builds first; the fixture pages are served by request routing.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
});
