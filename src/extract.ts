import { PLACEHOLDER_ATTR } from './content/hider';
import { normaliseText } from './fingerprint';
import { hasLineEnding, hasMarkerLine, hasWordLine, isAdClickUrl, isMarkerText } from './rules/markers';
import type { Adapter } from './adapters/schema';
import type { UnitPayload } from './types';

const MAX_TEXT = 600;
const MAX_LABELS = 5;
const MAX_LABEL_LEN = 40;
/** Suggested labels longer than this are post text, not header chrome. */
const MAX_SUGGESTED_LABEL = 300;
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
export function renderedWithin(node: Element, unit: Element, cache?: VisibilityCache): boolean {
  const view = node.ownerDocument.defaultView;
  if (!view) return true;
  // Label nodes of one unit share most ancestors: remember each ancestor's answer
  // for the duration of one decision, so the header pays for its style reads once.
  const path: Element[] = [];
  let shown = true;
  for (let el: Element | null = node; el && el !== unit; el = el.parentElement) {
    const known = cache?.get(el);
    if (known !== undefined) {
      shown = known;
      break;
    }
    path.push(el);
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') {
      shown = false;
      break;
    }
  }
  if (cache) for (const el of path) cache.set(el, shown);
  return shown;
}

/** Per-decision memo of renderedWithin answers, keyed by element. */
export type VisibilityCache = Map<Element, boolean>;

/**
 * Visible text of a node inside a unit; '' when the node is not rendered. Most
 * label nodes are leaves, and a rendered leaf shows exactly its text, so only
 * nodes with children pay for the walk.
 */
function labelText(node: Element, unit: Element, cache?: VisibilityCache): string {
  if (!renderedWithin(node, unit, cache)) return '';
  return node.firstElementChild ? renderedText(node) : (node.textContent ?? '');
}

/**
 * The placeholder now lives inside the unit (its first child), so a broad label
 * or link selector run against the unit can reach it too. It carries no light-DOM
 * text or hrefs of its own (its content lives in its shadow root), but skip it
 * anyway: it is never a candidate label, link or marker.
 */
function safeQueryAll(root: Element, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector)).filter((el) => !el.hasAttribute(PLACEHOLDER_ATTR));
  } catch {
    return [];
  }
}

/**
 * The unit itself when it matches, else the first descendant match, else null,
 * including when the selector is invalid (hard rule 2).
 */
function safeQuery(unit: Element, selector: string): Element | null {
  try {
    if (unit.matches(selector)) return unit;
    return unit.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Label nodes in document order: nodes inside the adapter's ignore selector (author
 * links) are dropped first, then the list is capped at the node limit. The ignore
 * check stops once the limit is full, so a broad selector over a long post does
 * not pay a `closest` per body span.
 */
function labelNodes(unit: Element, adapter: Adapter, selectors = adapter.labelSelectors, limit = adapter.labelNodeLimit): Element[] {
  if (selectors.length === 0) return [];
  const nodes = safeQueryAll(unit, selectors.join(', '));
  const ignore = adapter.labelIgnoreSelector;
  if (!ignore) return limit ? nodes.slice(0, limit) : nodes;
  const out: Element[] = [];
  for (const n of nodes) {
    if (limit && out.length >= limit) break;
    let c: Element | null = null;
    try {
      c = n.closest(ignore);
    } catch {
      out.push(n);
      continue;
    }
    if (!c || !unit.contains(c) || c === unit) out.push(n);
  }
  return out;
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
  const root = adapter?.textRootSelector ? (safeQuery(unit, adapter.textRootSelector) ?? unit) : unit;
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

/**
 * Whether a muted-word match found in `unitText` is actually rendered. `unitText`
 * walks every text node (including hidden ones) because it also feeds the
 * fingerprint, so a decoy or collapsed-tail occurrence must not change what the
 * post fingerprints as. A custom hide is a different question: it must fire only
 * on a word the reader can see. Walks the unit's own text nodes (a TreeWalker,
 * never a layout) and stops at the first one the pattern matches and
 * `renderedWithin` confirms, so this only costs style reads when a word actually
 * matched (hard rule 7).
 */
export function mutedWordRendered(unit: Element, pattern: RegExp): boolean {
  const doc = unit.ownerDocument;
  const walker = doc.createTreeWalker(unit, 4 /* NodeFilter.SHOW_TEXT */);
  const cache: VisibilityCache = new Map();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || SKIP_TEXT_IN.has(parent.localName.toUpperCase())) continue;
    const t = n.nodeValue ?? '';
    if (t && pattern.test(t) && renderedWithin(parent, unit, cache)) return true;
  }
  return false;
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
  /** The adapter's named suggested rule that matched, if any. */
  rule?: string;
  /**
   * The element that triggered the hit, for kinds `structural`, `ad-link` and
   * `rel`: the element `unit.querySelector(sel)` found (or the unit itself, when
   * the unit matched the selector directly), or the anchor. Lets the scanner check
   * whether that element is actually rendered before deciding to hide on it (label
   * and aria kinds already go through `renderedWithin`, so they leave this unset).
   */
  node?: Element;
};

export type DetectOptions = {
  suggested?: boolean;
  /** Suggested rule ids switched off on this site. */
  offRules?: ReadonlySet<string>;
};

const NO_RULES: ReadonlySet<string> = new Set();

/** Resolving aria-labelledby touches the document, so cap how many a unit may cost. */
const MAX_LABELLEDBY = 40;
/** No marker word, with the punctuation sites put around it, is longer than this. */
const MAX_MARKER_ATTR = 24;
/** Cheap reject before parsing a URL: every ad-click host or path contains one of these. */
const AD_CLICK_HINT = /aclk|googleadservices|doubleclick/i;

/**
 * Tier 0 marker detection for one unit. Returns the first sponsored hit, else the
 * first suggested hit (only when asked for), else null. Cheap checks first;
 * computed style (a style pass, never layout) last.
 */
export function detectMarker(unit: Element, adapter: Adapter | null, base: string, opts: DetectOptions = {}): MarkerHit | null {
  const sponsored = (kind: MarkerHit['kind'], detail: string, node?: Element): MarkerHit => ({ kind, category: 'sponsored', detail, node });
  for (const sel of adapter?.adSelectors ?? []) {
    const node = safeQuery(unit, sel);
    if (node) return sponsored('structural', sel, node);
  }
  // An ad-click URL marks a unit only where such a link can't be a user's own: on
  // Google itself and on opted-in generic sites (a news page's ad slot). On a
  // social feed a post can link to doubleclick.net or googleadservices.com in its
  // body (a privacy thread, an adtech job ad) and stay a real post (hard rule 6).
  const adLinks = !adapter || adapter.id === 'google';
  for (const a of safeQueryAll(unit, 'a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (adLinks && AD_CLICK_HINT.test(href) && isAdClickUrl(href, base)) return sponsored('ad-link', new URL(href, base).hostname, a);
    // rel=sponsored stays global (decided 2026-09-25): it is the publisher's own
    // declaration that a link is paid, none of the launch sites emit it on user
    // posts, and on an opted-in generic site a unit built around a paid link is
    // what the user asked to hide. Ad-click URLs, by contrast, are gated above.
    const rel = a.getAttribute('rel');
    if (rel && rel.split(/\s+/).includes('sponsored')) return sponsored('rel', 'rel=sponsored', a);
  }
  for (const el of safeQueryAll(unit, '[aria-label]')) {
    const v = el.getAttribute('aria-label') ?? '';
    if (v.length <= MAX_MARKER_ATTR && isMarkerText(v)) return sponsored('aria', v);
  }
  const labelledBy = labelledByMarker(unit);
  if (labelledBy) return sponsored('aria', labelledBy);
  const cache: VisibilityCache = new Map();
  let labels: string[] | null = null;
  if (adapter) {
    labels = labelNodes(unit, adapter).map((node) => labelText(node, unit, cache));
    for (const t of labels) {
      if (hasMarkerLine(t)) return sponsored('label', normaliseText(t).slice(0, MAX_LABEL_LEN));
    }
  } else {
    const hit = genericLabelHit(unit, cache);
    if (hit) return sponsored('label', hit);
  }
  if (opts.suggested && adapter?.suggested) return detectSuggested(unit, adapter, labels ?? [], opts.offRules ?? NO_RULES, cache);
  return null;
}

const wordSets = new WeakMap<object, ReadonlySet<string>>();
function wordSet(block: { words: string[] }): ReadonlySet<string> {
  let s = wordSets.get(block);
  if (!s) wordSets.set(block, (s = new Set(block.words.map((w) => w.toLowerCase()))));
  return s;
}

const endingLists = new WeakMap<object, readonly string[]>();
function endingList(block: { lineEndings?: string[] }): readonly string[] {
  let l = endingLists.get(block);
  if (!l) endingLists.set(block, (l = (block.lineEndings ?? []).map((e) => e.toLowerCase())));
  return l;
}

type Matcher = { selectors: string[]; words: string[]; lineEndings?: string[] };

function detectSuggested(unit: Element, adapter: Adapter, adapterLabels: string[], off: ReadonlySet<string>, cache?: VisibilityCache): MarkerHit | null {
  const block = adapter.suggested!;
  // The base fields, then each named rule the user hasn't switched off here.
  const matchers: { m: Matcher; rule?: string }[] = [{ m: block }];
  for (const r of block.rules) if (!off.has(r.id)) matchers.push({ m: r, rule: r.id });
  for (const { m, rule } of matchers) {
    for (const sel of m.selectors) {
      const node = safeQuery(unit, sel);
      if (node) return { kind: 'structural', category: 'suggested', detail: sel, rule, node };
    }
  }
  const textual = matchers.filter(({ m }) => wordSet(m).size > 0 || endingList(m).length > 0);
  if (textual.length === 0) return null;
  const texts = block.labelSelectors
    ? labelNodes(unit, adapter, block.labelSelectors, block.labelNodeLimit).map((n) => labelText(n, unit, cache))
    : adapterLabels;
  // A social line ("<Name> likes this") heads the card, so only the first label
  // counts for endings: a post body that says "everyone likes this" must not hide.
  const first = texts.find((t) => t.trim());
  for (const t of texts) {
    // A label node this long is post text that a broad selector reached, not a
    // header: a line reading "Follow" inside it is the author's, not the site's.
    if (t.length > MAX_SUGGESTED_LABEL) continue;
    for (const { m, rule } of textual) {
      if (hasWordLine(t, wordSet(m)) || (t === first && hasLineEnding(t, endingList(m)))) {
        return { kind: 'label', category: 'suggested', detail: normaliseText(t).slice(0, MAX_LABEL_LEN), rule };
      }
    }
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
function genericLabelHit(unit: Element, cache?: VisibilityCache): string | null {
  const candidates = safeQueryAll(unit, 'span, div, p, small, a, li, header *').slice(0, 300);
  for (const el of candidates) {
    const raw = el.textContent ?? '';
    if (raw.length > 60) continue; // skip containers before paying for computed style
    if (!isMarkerText(raw)) continue; // cheap reject before paying for layout
    const t = labelText(el, unit, cache);
    if (isMarkerText(t)) return normaliseText(t);
  }
  return null;
}
