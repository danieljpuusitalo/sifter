import { AdapterSchema, type Adapter } from './schema';
import google from './google.json';
import linkedin from './linkedin.json';
import reddit from './reddit.json';

// Parsed at load so a malformed adapter fails loudly in tests, not silently in a user's feed.
export const ADAPTERS: Adapter[] = [linkedin, reddit, google].map((a) => AdapterSchema.parse(a));

function hostMatches(hostname: string, host: string): boolean {
  const h = hostname.toLowerCase();
  return h === host || h.endsWith(`.${host}`);
}

export function adapterFor(hostname: string): Adapter | null {
  return ADAPTERS.find((a) => a.hosts.some((host) => hostMatches(hostname, host))) ?? null;
}
