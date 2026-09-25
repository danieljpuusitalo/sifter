import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { withDefaults, type RawAdapter } from '../../src/adapters/defaults';
import { allSelectors } from '../../src/adapters/selectors';

// happy-dom (tests/unit/adapters.test.ts) silently accepts selectors real Chrome
// rejects (CLAUDE.md), so that test alone is not enough. This runs every selector
// string every adapter carries through real Chromium's querySelectorAll, on a
// blank page (never a live site), and asserts none of them throws.
//
// Adapters are read straight off disk instead of through src/adapters/index.ts:
// Playwright's test runner loads spec files as plain Node ESM, which (unlike
// Vite/wxt/vitest) requires an import attribute on every JSON import, so pulling
// in index.ts's un-attributed `import facebook from './facebook.json'` throws
// here even though it works everywhere else.
const ADAPTER_FILES = ['linkedin', 'reddit', 'google', 'x', 'instagram', 'facebook', 'threads'];

test('every adapter selector is valid in real Chromium', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  const adapters = ADAPTER_FILES.map((id) => {
    const raw = JSON.parse(readFileSync(join('src', 'adapters', `${id}.json`), 'utf8')) as RawAdapter;
    return withDefaults(raw);
  });
  const selectors = adapters.flatMap((a) => allSelectors(a).map((sel) => ({ id: a.id, sel })));
  expect(selectors.length).toBeGreaterThan(0); // positive control: there is something to check

  const results = await page.evaluate(
    (items) =>
      items.map(({ id, sel }) => {
        try {
          document.querySelectorAll(sel);
          return { id, sel, ok: true, error: null as string | null };
        } catch (e) {
          return { id, sel, ok: false, error: String(e) };
        }
      }),
    selectors,
  );

  const failed = results.filter((r) => !r.ok);
  expect(failed, failed.map((f) => `${f.id}: ${f.sel} -> ${f.error}`).join('\n')).toEqual([]);
});
