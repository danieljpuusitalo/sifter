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
  ...GOOGLE_DOMAINS.map((d) => `https://www.${d}/*`),
];
