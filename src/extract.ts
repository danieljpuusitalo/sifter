import { normaliseText } from './fingerprint';
import { hasMarkerLine, hasWordLine, isAdClickUrl, isMarkerText } from './rules/markers';
import type { Adapter } from './adapters/schema';
import type { UnitPayload } from './types';

const MAX_TEXT = 600;
const MAX_LABELS = 5;
const MAX_LABEL_LEN = 40;
const MAX_LINK_HOSTS = 5;

const CTA_TEXT = /^(shop now|buy now|learn more|install|install now|sign up|download|get offer|order now|book now|apply now|get started|subscribe|try (it )?(for )?free)$/i;

const SKIP_TEXT_IN = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|flow-root)/;
/** Label nodes are short; past this their text can't be a marker line anyway. */
const MAX_RENDERED = 400;

/** Chrome always computes visibility; happy-dom leaves it empty unless set, meaning "inherit". */
const shows = (visibility: string, parent: boolean): boolean => (visibility ? visibility === 'visible' : parent);

/**
 * The text a label node shows, without forcing layout. innerText skips decoy spans
 * but lays out the whole page when it is dirty, which on a live feed mid-scroll
 * cost 12-13 ms for a single unit. Computed style costs a style pass only, so walk
 * the node: drop display:none, opacity:0 and visibility:hidden text, and break
 * lines at block boxes and <br> the way innerText does. Split words
 * ("Pro<span>moted</span>") still join, because inline boxes add no break.
 */
export function renderedText(node: Element): string {
  const view = node.ownerDocument.defaultView;
  if (!view) return node.textContent ?? '';
  const parts: string[] = [];
  let len = 0;
  const walk = (el: Element, visible: boolean): void => {
    for (let n = el.firstChild; n && len < MAX_RENDERED; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const t = n.nodeValue ?? '';
        if (visible && t) {
          parts.push(t);
          len += t.length;
        }
        continue;
      }
      if (n.nodeType !== 1) continue;
      const child = n as Element;
      const name = child.localName.toUpperCase();
      if (SKIP_TEXT_IN.has(name)) continue;
      if (name === 'BR') {
        parts.push('\n');
        continue;
      }
      const cs = view.getComputedStyle(child);
      if (cs.display === 'none' || cs.opacity === '0') continue;
      // visibility inherits, and a visible child of a hidden parent does show.
      const block = BLOCK_DISPLAY.test(cs.display);
      if (block) parts.push('\n');
      walk(child, shows(cs.visibility, visible));
      if (block) parts.push('\n');
    }
  };
  walk(node, shows(view.getComputedStyle(node).visibility, true));
  return parts.join('');
}

/**
 * Whether a label node is actually shown. innerText alone is not enough: for an
 * element that is itself display:none, the spec returns its full textContent, so
 * a hidden "Promoted" decoy would read as visible. Stops at the unit, because our
 * own hide puts display:none on the unit and must not blind the rescan.
 */
export function renderedWithin(node: Element, unit: Element): boolean {
  const view = node.ownerDocument.defaultView;
  if (!view) return true;
  for (let el: Element | null = node; el && el !== unit; el = el.parentElement) {
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') {
      return false;
    }
  }
  return true;
}

/**
 * Visible text of a node inside a unit; '' when the node is not rendered. Most
 * label nodes are leaves, and a rendered leaf shows exactly its text, so only
 * nodes with children pay for the walk.
 */
function labelText(node: Element, unit: Element): string {
  if (!renderedWithin(node, unit)) return '';
  return node.firstElementChild ? renderedText(node) : (node.textContent ?? '');
}

function safeQueryAll(root: Element, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Label nodes in document order: nodes inside the adapter's ignore selector (author
 * links) are dropped first, then the list is capped at the node limit.
 */
function labelNodes(unit: Element, adapter: Adapter, selectors = adapter.labelSelectors, limit = adapter.labelNodeLimit): Element[] {
  if (selectors.length === 0) return [];
  let nodes = safeQueryAll(unit, selectors.join(', '));
  const ignore = adapter.labelIgnoreSelector;
  if (ignore) {
    nodes = nodes.filter((n) => {
      let c: Element | null = null;
      try {
        c = n.closest(ignore);
      } catch {
        return true;
      }
      return !c || !unit.contains(c) || c === unit;
    });
  }
  return limit ? nodes.slice(0, limit) : nodes;
}

export function labelTexts(unit: Element, adapter: Adapter | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const nodes = adapter ? labelNodes(unit, adapter) : [];
  for (const node of nodes) {
    const t = normaliseText(labelText(node, unit));
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t.slice(0, MAX_LABEL_LEN));
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

export function linkHosts(unit: Element, pageHost: string, base: string): string[] {
  const hosts = new Set<string>();
  for (const a of safeQueryAll(unit, 'a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    try {
      const host = new URL(href, base).hostname.toLowerCase();
      if (host && host !== pageHost) hosts.add(host);
    } catch {
      /* unparsable href: ignore */
    }
    if (hosts.size >= MAX_LINK_HOSTS) break;
  }
  return [...hosts];
}

export function hasCta(unit: Element): boolean {
  return safeQueryAll(unit, 'a, button, [role="button"]').some((el) =>
    CTA_TEXT.test(normaliseText(el.textContent ?? '')),
  );
}

/** Past this much text a unit's identity and muted-word check are settled. */
const MAX_UNIT_TEXT = 5000;

/**
 * A unit's text, for its fingerprint and muted words. Deliberately NOT innerText:
 * once Sifter hides a unit (display:none), innerText falls back to textContent and
 * drops the line breaks between blocks, so the same post would fingerprint
 * differently hidden and shown, and a stored "Hide" or "Not an ad" would stop
 * matching the moment the page re-decides it. Text nodes joined with spaces read
 * the same either way, and cost no layout.
 */
export function unitText(unit: Element, adapter: Adapter | null): string {
  const root = adapter?.textRootSelector ? (unit.querySelector(adapter.textRootSelector) ?? unit) : unit;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  let len = 0;
  for (let n = walker.nextNode(); n && len < MAX_UNIT_TEXT; n = walker.nextNode()) {
    const parent = n.parentElement;
    // localName, not tagName: an SVG <style> reports a lowercase tagName.
    if (parent && SKIP_TEXT_IN.has(parent.localName.toUpperCase())) continue;
    const t = n.nodeValue ?? '';
    if (!t.trim()) continue;
    parts.push(t);
    len += t.length;
  }
  return normaliseText(parts.join(' ')).slice(0, MAX_UNIT_TEXT);
}

export function buildPayload(
  id: string,
  unit: Element,
  adapter: Adapter | null,
  pageHost: string,
  base: string,
): UnitPayload {
  return {
    id,
    text: unitText(unit, adapter).slice(0, MAX_TEXT),
    labels: labelTexts(unit, adapter),
    linkHosts: linkHosts(unit, pageHost, base),
    hasCta: hasCta(unit),
  };
}

export type MarkerHit = {
  kind: 'structural' | 'label' | 'aria' | 'rel' | 'ad-link';
  /** What the site is doing: a paid placement, or a recommendation from someone you don't follow. */
  category: 'sponsored' | 'suggested';
  detail: string;
};

export type DetectOptions = { suggested?: boolean };

/** Resolving aria-labelledby touches the document, so cap how many a unit may cost. */
const MAX_LABELLEDBY = 40;

/**
 * Tier 0 marker detection for one unit. Returns the first sponsored hit, else the
 * first suggested hit (only when asked for), else null. Cheap checks first;
 * computed style (a style pass, never layout) last.
 */
export function detectMarker(unit: Element, adapter: Adapter | null, base: string, opts: DetectOptions = {}): MarkerHit | null {
  const sponsored = (kind: MarkerHit['kind'], detail: string): MarkerHit => ({ kind, category: 'sponsored', detail });
  for (const sel of adapter?.adSelectors ?? []) {
    if (safeMatches(unit, sel) || safeQueryAll(unit, sel).length > 0) return sponsored('structural', sel);
  }
  for (const a of safeQueryAll(unit, 'a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (isAdClickUrl(href, base)) return sponsored('ad-link', new URL(href, base).hostname);
    if ((a.getAttribute('rel') ?? '').split(/\s+/).includes('sponsored')) return sponsored('rel', 'rel=sponsored');
  }
  for (const el of safeQueryAll(unit, '[aria-label]')) {
    const v = el.getAttribute('aria-label') ?? '';
    if (isMarkerText(v)) return sponsored('aria', v);
  }
  const labelledBy = labelledByMarker(unit);
  if (labelledBy) return sponsored('aria', labelledBy);
  let labels: string[] | null = null;
  if (adapter) {
    labels = labelNodes(unit, adapter).map((node) => labelText(node, unit));
    for (const t of labels) {
      if (hasMarkerLine(t)) return sponsored('label', normaliseText(t).slice(0, MAX_LABEL_LEN));
    }
  } else {
    const hit = genericLabelHit(unit);
    if (hit) return sponsored('label', hit);
  }
  if (opts.suggested && adapter?.suggested) return detectSuggested(unit, adapter, labels ?? []);
  return null;
}

const wordSets = new WeakMap<object, ReadonlySet<string>>();
function wordSet(block: { words: string[] }): ReadonlySet<string> {
  let s = wordSets.get(block);
  if (!s) wordSets.set(block, (s = new Set(block.words.map((w) => w.toLowerCase()))));
  return s;
}

function detectSuggested(unit: Element, adapter: Adapter, adapterLabels: string[]): MarkerHit | null {
  const block = adapter.suggested!;
  for (const sel of block.selectors) {
    if (safeMatches(unit, sel) || safeQueryAll(unit, sel).length > 0) return { kind: 'structural', category: 'suggested', detail: sel };
  }
  const words = wordSet(block);
  if (words.size === 0) return null;
  const texts = block.labelSelectors
    ? labelNodes(unit, adapter, block.labelSelectors, block.labelNodeLimit).map((n) => labelText(n, unit))
    : adapterLabels;
  for (const t of texts) {
    if (hasWordLine(t, words)) return { kind: 'label', category: 'suggested', detail: normaliseText(t).slice(0, MAX_LABEL_LEN) };
  }
  return null;
}

/**
 * Sites that scramble a visible "Sponsored" into split or decoy spans still have
 * to tell screen readers the truth, often through aria-labelledby pointing at a
 * clean copy of the word. The accessible name is the honest signal, so read it.
 * The referenced node may itself be visually hidden: that is how the pattern works.
 */
function labelledByMarker(unit: Element): string | null {
  const doc = unit.ownerDocument;
  const els = safeQueryAll(unit, '[aria-labelledby]');
  for (let i = 0; i < els.length && i < MAX_LABELLEDBY; i++) {
    const ids = (els[i]!.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const name = ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
    if (name && name.length <= 40 && isMarkerText(name)) return normaliseText(name);
  }
  return null;
}
/**
 * Sites without an adapter have no label selectors. Look for a short element
 * whose whole visible text is a marker word. Bounded so a huge unit can't blow
 * the per-batch budget.
 */
function genericLabelHit(unit: Element): string | null {
  const candidates = safeQueryAll(unit, 'span, div, p, small, a, li, header *').slice(0, 300);
  for (const el of candidates) {
    const raw = el.textContent ?? '';
    if (raw.length > 60) continue; // skip containers before paying for computed style
    if (!isMarkerText(raw)) continue; // cheap reject before paying for layout
    const t = labelText(el, unit);
    if (isMarkerText(t)) return normaliseText(t);
  }
  return null;
}
