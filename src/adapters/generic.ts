// Generic extractor for sites without an adapter (BRIEF.md §5 step 1).
//
// A "feed" is any container with 4 or more children that share a tag + class
// signature; each such child is a unit. Units nest (a page section of cards, each
// card with a list of tags), so we keep only the innermost units: hiding a whole
// section because one card inside it is an ad would violate precision-over-recall.

const MIN_GROUP = 4;
const MIN_TEXT = 80;
const MAX_SCAN = 6000;
const SKIP_ANCESTORS = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
/** Tags that make terrible units: paragraphs of an article, inline runs, table rows. */
const NON_UNIT_TAGS = new Set(['P', 'SPAN', 'A', 'TD', 'TR', 'OPTION', 'BR', 'IMG', 'svg', 'SCRIPT', 'STYLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
/** A bare classless div is too common to count as a shared signature. */
const SEMANTIC_BARE = new Set(['ARTICLE', 'LI', 'SECTION']);

function signature(el: Element): string | null {
  if (NON_UNIT_TAGS.has(el.tagName)) return null;
  const classes = Array.from(el.classList).sort().join('.');
  if (!classes && !SEMANTIC_BARE.has(el.tagName)) return null;
  return `${el.tagName}.${classes}`;
}

export function findGenericUnits(root: Element): Element[] {
  const candidates = new Set<Element>();
  const all = [root, ...Array.from(root.querySelectorAll('*')).slice(0, MAX_SCAN)];
  for (const container of all) {
    if (container.childElementCount < MIN_GROUP) continue;
    const groups = new Map<string, Element[]>();
    for (const child of Array.from(container.children)) {
      const sig = signature(child);
      if (!sig) continue;
      const g = groups.get(sig);
      if (g) g.push(child);
      else groups.set(sig, [child]);
    }
    for (const group of groups.values()) {
      if (group.length < MIN_GROUP) continue;
      for (const child of group) {
        if (child.closest(SKIP_ANCESTORS)) continue;
        if ((child.textContent ?? '').replace(/\s+/g, ' ').trim().length < MIN_TEXT) continue;
        candidates.add(child);
      }
    }
  }
  return innermost(candidates);
}

/**
 * Drop any unit that contains another unit. Used for adapters too: Google nests
 * result wrappers (one held 11 results), and hiding a wrapper because an ad sits
 * somewhere inside it would hide real results.
 */
export function innermost(units: Iterable<Element>): Element[] {
  const set = new Set(units);
  const outer = new Set<Element>();
  for (const el of set) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (set.has(p)) outer.add(p);
    }
  }
  return [...set].filter((el) => !outer.has(el));
}
