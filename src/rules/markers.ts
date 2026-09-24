// Tier 0 marker detection (BRIEF.md §5 step 3.3). Free, synchronous, no model.
//
// Precision over recall: a marker only counts when a label's whole visible text
// is a marker word. "Ad" as a substring of "Adobe" or "Read more" must never hit.

/** Visible label words that mean "paid placement", across the launch locales. */
export const MARKER_WORDS = [
  'sponsored',
  'promoted',
  'ad',
  'ads',
  'advertisement',
  'gesponsord',
  'gepromoot', // LinkedIn NL; not in the brief's list
  'advertentie',
  'gesponsert',
  'anzeige',
  'sponsrad',
  'sponsoreret',
  'sponset',
  'mainos',
  'sponsoroitu',
  'sponsorisé',
  'patrocinado',
] as const;

const MARKER_SET = new Set<string>(MARKER_WORDS);

/** Punctuation and separators sites put around a label ("Promoted ·", "Sponsored:"). */
const EDGE_JUNK = /^[\s·•|:\-–—()[\]]+|[\s·•|:\-–—()[\]]+$/g;

/** A label's comparable form: whitespace collapsed, edge punctuation dropped, lower case. */
export function labelKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(EDGE_JUNK, '').toLowerCase();
}

export function isMarkerText(raw: string): boolean {
  return MARKER_SET.has(labelKey(raw));
}

/** Whether any line of a label is exactly one of `words` (already lower case). */
export function hasWordLine(raw: string, words: ReadonlySet<string>): boolean {
  return words.size > 0 && raw.split(/\n/).some((line) => words.has(labelKey(line)));
}

/**
 * Some sites render the label as its own line inside a longer header
 * ("Company name\nPromoted"). Any single line that is a marker counts.
 */
export function hasMarkerLine(raw: string): boolean {
  return raw.split(/\n/).some((line) => isMarkerText(line));
}

const AD_CLICK_HOSTS = ['googleadservices.com', 'doubleclick.net'];

export function isAdClickUrl(href: string, base: string): boolean {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (AD_CLICK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // Google's own ad redirect: a whole /aclk path segment on a google.* host.
  // A substring match would flag any site's "/aclk-guide" page.
  return /(^|\.)google\.[a-z.]+$/.test(host) && url.pathname.split('/').includes('aclk');
}
