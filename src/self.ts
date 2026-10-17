import type { Adapter } from './adapters/schema';

// The viewer's own profile id (an adapter's `self`), so a post that mentions them is
// never hidden as suggested. Learned from links only the viewer's own page chrome
// carries, kept in storage by the service worker, and only ever used as part of a
// selector here: never sent anywhere, never logged.

export type SelfConfig = NonNullable<Adapter['self']>;

/** A profile id: what a vanity path segment holds. Page data, so it is checked before it goes into a selector. */
export const SELF_ID_RE = /^[A-Za-z0-9_%-]{1,100}$/;

/** What the scanner compiles once per context: the id plus the selector that finds links to it. */
export type SelfMatch = { prefix: string; id: string; selector: string };

/** The profile id in a link, or null. Same-site paths and absolute URLs both count; the id ends at `/`, `?` or `#`. */
export function selfIdOf(href: string, prefix: string): string | null {
  const path = href.replace(/^https?:\/\/[^/]+/i, '');
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const end = rest.search(/[/?#]/);
  const id = end === -1 ? rest : rest.slice(0, end);
  return SELF_ID_RE.test(id) ? id : null;
}

/** Links that must agree before an id counts as the viewer's: one stray link is not enough. */
const MIN_AGREEING = 2;

/**
 * The viewer's id from the profile links in the first element `source` matches: at
 * least two of them, and all naming the same id. A mix of ids (the rail now shows
 * someone else) learns nothing.
 */
export function learnSelf(doc: Document, self: SelfConfig): string | null {
  let links: Element[];
  try {
    const root = doc.querySelector(self.source);
    if (!root) return null;
    links = [...root.querySelectorAll(`a[href*="${self.prefix}"]`)];
  } catch {
    return null;
  }
  let id: string | null = null;
  let count = 0;
  for (const a of links) {
    const got = selfIdOf(a.getAttribute('href') ?? '', self.prefix);
    if (!got) continue;
    if (id !== null && got !== id) return null;
    id = got;
    count++;
  }
  return count >= MIN_AGREEING ? id : null;
}

/**
 * Learn only on the adapter's feed pages (`suggestedPaths`), where `source` was checked
 * live. On someone else's profile the first rail could link only to them, and the
 * viewer would be learned as that person.
 */
export function learnsOn(adapter: Pick<Adapter, 'suggestedPaths'>, path: string): boolean {
  if (!adapter.suggestedPaths) return true;
  return adapter.suggestedPaths.some((p) => {
    try {
      return new RegExp(p).test(path);
    } catch {
      return false;
    }
  });
}

/** Compile the match for a stored id, or null when there is none or it is malformed. */
export function selfMatch(self: SelfConfig | undefined, id: string | undefined): SelfMatch | null {
  if (!self || !id || !SELF_ID_RE.test(id)) return null;
  // SELF_ID_RE and the schema's prefix pattern admit no quote or backslash, so this is a literal.
  return { prefix: self.prefix, id, selector: `a[href*="${self.prefix}${id}"]` };
}

/** The unit links to the viewer's profile: a mention, a tag, their own comment. One attribute query. */
export function mentionsSelf(unit: Element, m: SelfMatch): boolean {
  for (const a of unit.querySelectorAll(m.selector)) {
    if (selfIdOf(a.getAttribute('href') ?? '', m.prefix) === m.id) return true;
  }
  return false;
}
