import { defineConfig } from '@playwright/test';

// E2E runs the built extension against local fixtures only (never live sites).
// `pnpm test:e2e` builds first; the fixture pages are served by request routing.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // The scanner works in idle slices, so on a starved runner the first hide can
  // take well over Playwright's 5 s default; a taller expect timeout costs nothing
  // on a green run and stops a slow CI box from failing a correct build.
  expect: { timeout: 15_000 },
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
});
