// Launch-site match patterns. Shared by the manifest (host_permissions) and the
// content script registration, so the two can never drift apart.
//
// Chrome match patterns cannot wildcard a TLD (`*://www.google.*/*` is invalid),
// so Google's country domains are enumerated.

export const GOOGLE_DOMAINS = [
  'google.com',
  'google.nl',
  'google.de',
  'google.co.uk',
  'google.fr',
  'google.be',
  'google.at',
  'google.ch',
  'google.es',
  'google.it',
  'google.pt',
  'google.ie',
  'google.se',
  'google.fi',
  'google.dk',
  'google.no',
  'google.pl',
  'google.ca',
  'google.com.au',
] as const;

export const LAUNCH_MATCHES: string[] = [
  'https://www.linkedin.com/*',
  'https://www.reddit.com/*',
  'https://x.com/*',
  'https://twitter.com/*',
  'https://www.instagram.com/*',
  'https://www.facebook.com/*',
  'https://www.threads.com/*',
  'https://www.threads.net/*',
  ...GOOGLE_DOMAINS.map((d) => `https://www.${d}/*`),
];

const LAUNCH_HOSTS = new Set(LAUNCH_MATCHES.map((m) => new URL(m.replace('/*', '/')).hostname));

/**
 * Hosts the manifest injects into. Only these are "launch" hosts: a subdomain such
 * as old.reddit.com shares an adapter's domain but not the manifest match, so it
 * has to be opted in like any other site or it would never get the script.
 */
export function isLaunchHost(hostname: string): boolean {
  return LAUNCH_HOSTS.has(hostname.toLowerCase());
}

/** Hosts that are one site to the user, so they share one set of settings. */
const SITE_ALIASES: Record<string, string> = {
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'threads.net': 'threads.com',
  ...Object.fromEntries(GOOGLE_DOMAINS.map((d) => [d, 'google.com'])),
};

/** The key settings are stored under: hostname without "www.", with aliases folded. */
export function siteKey(hostname: string): string {
  const key = hostname.toLowerCase().replace(/^www\./, '');
  return SITE_ALIASES[key] ?? key;
}

/** A plain hostname: what may go into a match pattern. Rejects wildcards, ports, paths. */
export const HOSTNAME_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The sites Sifter ships an adapter for, by site key, in the order the UI lists them. */
export const LAUNCH_SITES: { key: string; name: string }[] = [
  { key: 'linkedin.com', name: 'LinkedIn' },
  { key: 'reddit.com', name: 'Reddit' },
  { key: 'google.com', name: 'Google Search' },
  { key: 'x.com', name: 'X' },
  { key: 'instagram.com', name: 'Instagram' },
  { key: 'facebook.com', name: 'Facebook' },
  { key: 'threads.com', name: 'Threads' },
];
