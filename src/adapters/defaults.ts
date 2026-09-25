import type { z } from 'zod';
import type { Adapter, AdapterSchema } from './schema';

// Split out of index.ts so this stays importable with no JSON module in its
// graph: Playwright's test runner loads spec files as plain Node ESM, which
// (unlike Vite/wxt/vitest) requires an import attribute on every JSON import,
// so tests/e2e/selector-canary.spec.ts reads the adapter files with node:fs
// and applies these defaults by hand instead of going through index.ts.

export type RawAdapter = z.input<typeof AdapterSchema>;

/** The schema's defaults, applied by hand. Kept in step with schema.ts by the adapters test. */
export function withDefaults(raw: RawAdapter): Adapter {
  const { suggested: rawSuggested, ...rest } = raw;
  const suggested: Adapter['suggested'] = rawSuggested
    ? {
        ...rawSuggested,
        selectors: rawSuggested.selectors ?? [],
        words: rawSuggested.words ?? [],
        rules: (rawSuggested.rules ?? []).map((r) => ({ ...r, selectors: r.selectors ?? [], words: r.words ?? [] })),
      }
    : undefined;
  return {
    ...rest,
    labelSelectors: raw.labelSelectors ?? [],
    adSelectors: raw.adSelectors ?? [],
    blocks: raw.blocks ?? [],
    ...(suggested ? { suggested } : {}),
  };
}
