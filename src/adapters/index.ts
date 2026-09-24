import type { z } from 'zod';
import type { Adapter, AdapterSchema } from './schema';
import facebook from './facebook.json';
import google from './google.json';
import instagram from './instagram.json';
import linkedin from './linkedin.json';
import reddit from './reddit.json';
import threads from './threads.json';
import x from './x.json';

// The adapters are validated by AdapterSchema in the unit tests (which also assert
// that `withDefaults` below agrees with the schema for every shipped adapter), so
// the content script does not carry zod or pay for a parse at every page load.
// Only the type is imported from schema.ts: that import is erased at build time.

type RawAdapter = z.input<typeof AdapterSchema>;

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

export const RAW_ADAPTERS: RawAdapter[] = [linkedin, reddit, google, x, instagram, facebook, threads];
export const ADAPTERS: Adapter[] = RAW_ADAPTERS.map(withDefaults);

function hostMatches(hostname: string, host: string): boolean {
  const h = hostname.toLowerCase();
  return h === host || h.endsWith(`.${host}`);
}

export function adapterFor(hostname: string): Adapter | null {
  return ADAPTERS.find((a) => a.hosts.some((host) => hostMatches(hostname, host))) ?? null;
}
