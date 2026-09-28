import { COLLAPSE_CLASS, HIDDEN_CLASS, PLACEHOLDER_ATTR } from './content/hider';
import { normaliseText } from './fingerprint';
import { MARKER_WORDS, hasLineEnding, hasMarkerLine, hasWordLine, isAdClickUrl, isMarkerText } from './rules/markers';
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
export function renderedText(node: Element, collapsedUnit?: Element): string {
  const view = node.ownerDocument.defaultView;
  if (!view) return node.textContent ?? '';
  const parts: string[] = [];
  let len = 0;
  const walk = (el: Element, visible: boolean): void => {
    const ours = el === collapsedUnit;
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
      // Our own collapse hides the unit's children; read them as the block boxes they were.
      const ownHide = ours && cs.display === 'none';
      if ((!ownHide && cs.display === 'none') || cs.opacity === '0') continue;
      // visibility inherits, and a visible child of a hidden parent does show.
      const block = ownHide || BLOCK_DISPLAY.test(cs.display);
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
  // Fast path: one native call walks every ancestor in C++, where the loop below
  // pays a getComputedStyle and four property reads per ancestor (the largest
  // self-time in a LinkedIn decision). It looks past the unit, so only a yes is
  // conclusive, and only while none of our own hiding sits on the unit; a no
  // (rare: a hidden label, or our collapse) falls through to the exact walk.
  if (!unit.classList.contains(HIDDEN_CLASS) && typeof node.checkVisibility === 'function' && node.checkVisibility(VISIBLE_OPTS)) return true;
  const collapsed = collapsedByUs(unit);
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
    const ownHide = collapsed && el.parentElement === unit;
    if ((cs.display === 'none' && !ownHide) || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') {
      shown = false;
      break;
    }
  }
  if (cache) for (const el of path) cache.set(el, shown);
  return shown;
}

/**
 * Chrome 121 renamed the options; 105-120 (the floor is 116) know only the old
 * names and would ignore the new ones, reading an opacity:0 decoy as visible.
 */
const VISIBLE_OPTS = { opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true } as CheckVisibilityOptions;

/** Per-decision memo of renderedWithin answers, keyed by element. */
export type VisibilityCache = Map<Element, boolean>;

/**
 * Whether Sifter's own collapse is what hides this unit's content. UNIT_CSS puts
 * display:none on every direct child but the placeholder, and nothing else, so a
 * rescan discounts exactly that and reads the unit as the site built it. The
 * alternative, lifting the classes for the read, un-hid the whole post for one
 * getComputedStyle: a full style recalc plus a forced layout of the post, then
 * again for the page when the classes went back (9-10 ms per rescan on LinkedIn,
 * measured by bench/live.ts). The trade: a site's own display:none on a direct
 * child of an already-hidden unit reads as shown. The first decision, made before
 * Sifter touched the unit, still sees it; blur changes nothing read here.
 */
export function collapsedByUs(unit: Element): boolean {
  return unit.classList.contains(HIDDEN_CLASS) && unit.classList.contains(COLLAPSE_CLASS);
}

/**
 * Visible text of a node inside a unit; '' when the node is not rendered. Most
 * label nodes are leaves, and a rendered leaf shows exactly its text, so only
 * nodes with children pay for the walk.
 */
function labelText(node: Element, unit: Element, cache?: VisibilityCache): string {
  if (!renderedWithin(node, unit, cache)) return '';
  return node.firstElementChild ? renderedText(node, collapsedByUs(unit) ? unit : undefined) : (node.textContent ?? '');
}

/**
 * What a label read is looking for, so a node that cannot carry it skips the
 * style reads. `plain` is every wanted word lower-cased with its whitespace
 * removed, for the piecewise check on nodes with children.
 */
type Wanted = { markers: boolean; words: readonly ReadonlySet<string>[]; endings: readonly (readonly string[])[]; plain: readonly string[] };

function wanted(markers: boolean, words: readonly ReadonlySet<string>[], endings: readonly (readonly string[])[]): Wanted {
  const plain: string[] = [];
  if (markers) for (const m of MARKER_WORDS) plain.push(m);
  for (const s of words) for (const word of s) plain.push(word);
  for (const e of endings) for (const x of e) plain.push(x);
  return { markers, words, endings, plain: plain.map((p) => p.replace(/\s+/g, '')) };
}

/**
 * A label node's text and whether a style read confirmed it is shown. Most label
 * nodes on a feed are names, timestamps and empty buttons: on a live LinkedIn feed
 * their computed-style reads were the largest share of a decision, and the first
 * such read after the page mutates forces a style recalc of everything the page
 * has dirtied (8-12 ms mid-scroll, bench/live.ts). So the raw text is checked
 * first, and the style reads run only for a node that could actually hit:
 *
 * - A leaf renders exactly its text or nothing, so the hit checks themselves run
 *   on the raw text. When they miss, visibility cannot change the answer.
 * - A node with children renders some of its text nodes, whole, in order (hidden
 *   descendants drop theirs), with line breaks at block boxes. So a rendered
 *   marker word can be read across the node's text pieces, skipping whole pieces:
 *   `spansPieces` checks exactly that, whitespace aside, and nothing rendered can
 *   match a word it rejects. A decoy spliced inside the word ("Pro<hidden>x</hidden>moted")
 *   still reads as a candidate and pays the full read, as before.
 *
 * An unconfirmed label keeps its raw text, which by construction hits nothing.
 * Only `firstShown` needs to know whether it is actually shown, and resolves it then.
 */
type Label = { text: string; node: Element; confirmed: boolean };

function readLabel(node: Element, unit: Element, cache: VisibilityCache, w: Wanted): Label {
  const raw = node.textContent ?? '';
  const candidate = node.firstElementChild ? piecesMayHit(node, w) : leafMayHit(raw, w);
  if (!candidate) return { text: raw, node, confirmed: false };
  return { text: labelText(node, unit, cache), node, confirmed: true };
}

function leafMayHit(raw: string, w: Wanted): boolean {
  if (w.markers && hasMarkerLine(raw)) return true;
  if (raw.length > MAX_SUGGESTED_LABEL) return false;
  return w.words.some((s) => hasWordLine(raw, s)) || w.endings.some((e) => hasLineEnding(raw, e));
}

/** Past this many text nodes the node is post text; read it fully rather than reason about it. */
const MAX_PIECES = 64;

function piecesMayHit(node: Element, w: Wanted): boolean {
  const walker = node.ownerDocument.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  const pieces: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.nodeValue ?? '').replace(/\s+/g, '').toLowerCase();
    if (!t) continue;
    if (pieces.length >= MAX_PIECES) return true;
    pieces.push(t);
  }
  return w.plain.some((word) => spansPieces(word, pieces));
}

/**
 * Whether `word` can be read across `pieces` in order, using each piece whole
 * except the first (from its end) and the last (from its start), with any pieces
 * skipped. That is every string that hiding whole text nodes and joining the rest
 * can produce, so it is a superset of any rendered match. Both sides are lower
 * case with whitespace removed.
 */
function spansPieces(word: string, pieces: string[]): boolean {
  // Matched prefix lengths reachable so far; skipping a piece keeps each of them.
  let states = new Set<number>();
  for (const p of pieces) {
    if (p.includes(word)) return true;
    const next = new Set<number>(states);
    for (let k = Math.min(p.length, word.length - 1); k >= 1; k--) {
      if (p.endsWith(word.slice(0, k))) next.add(k);
    }
    for (const j of states) {
      const rest = word.slice(j);
      if (p.startsWith(rest)) return true;
      if (rest.startsWith(p)) next.add(j + p.length);
    }
    states = next;
  }
  return false;
}

/**
 * The first label that is actually shown and not blank, read exactly (unconfirmed
 * labels pay their style reads here, in order, until one is shown). Only needed
 * once a later label carries a "<Name> likes this" line, so most units never pay.
 */
function firstShown(labels: Label[], unit: Element, cache: VisibilityCache): string | undefined {
  for (const l of labels) {
    if (!l.confirmed) {
      l.text = labelText(l.node, unit, cache);
      l.confirmed = true;
    }
    if (l.text.trim()) return l.text;
  }
  return undefined;
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

/** Anything a reader could see or click without text: an ad image or an iframe creative. */
const CONTENT_ELEMENTS = 'img, picture, video, iframe, canvas, embed, object, a[href]';

/**
 * Whether the unit holds anything at all. Google ships its ad shells (#tads,
 * #atvcap, #bottomads) on every results page and fills them only when it serves
 * ads, and the shell itself is the structural marker, so an empty one would get a
 * "Hidden" row that "Show" reveals nothing under. DOM reads only: stops at the
 * first non-blank text node, else one querySelector. Our placeholder keeps its
 * text in a shadow root and has no light children, so it never counts.
 */
export function hasContent(unit: Element): boolean {
  const walker = unit.ownerDocument.createTreeWalker(unit, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent && SKIP_TEXT_IN.has(parent.localName.toUpperCase())) continue;
    if ((n.nodeValue ?? '').trim()) return true;
  }
  return unit.querySelector(CONTENT_ELEMENTS) !== null;
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
  let labels: Label[] | null = null;
  if (adapter) {
    // These labels double as the suggested labels when the adapter's suggested block
    // has no selectors of its own, so the read looks for those words too.
    const reuse = opts.suggested && adapter.suggested && !adapter.suggested.labelSelectors ? textualMatchers(adapter.suggested, opts.offRules ?? NO_RULES) : [];
    const w = wanted(true, reuse.map(({ m }) => wordSet(m)), reuse.map(({ m }) => endingList(m)));
    labels = labelNodes(unit, adapter).map((node) => readLabel(node, unit, cache, w));
    for (const { text } of labels) {
      if (hasMarkerLine(text)) return sponsored('label', normaliseText(text).slice(0, MAX_LABEL_LEN));
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

type SuggestedBlock = NonNullable<Adapter['suggested']>;

/** The base fields, then each named rule the user hasn't switched off here. */
function suggestedMatchers(block: SuggestedBlock, off: ReadonlySet<string>): { m: Matcher; rule?: string }[] {
  const matchers: { m: Matcher; rule?: string }[] = [{ m: block }];
  for (const r of block.rules) if (!off.has(r.id)) matchers.push({ m: r, rule: r.id });
  return matchers;
}

function textualMatchers(block: SuggestedBlock, off: ReadonlySet<string>): { m: Matcher; rule?: string }[] {
  return suggestedMatchers(block, off).filter(({ m }) => wordSet(m).size > 0 || endingList(m).length > 0);
}

function detectSuggested(unit: Element, adapter: Adapter, adapterLabels: Label[], off: ReadonlySet<string>, cache: VisibilityCache): MarkerHit | null {
  const block = adapter.suggested!;
  const matchers = suggestedMatchers(block, off);
  for (const { m, rule } of matchers) {
    for (const sel of m.selectors) {
      const node = safeQuery(unit, sel);
      if (node) return { kind: 'structural', category: 'suggested', detail: sel, rule, node };
    }
  }
  const textual = matchers.filter(({ m }) => wordSet(m).size > 0 || endingList(m).length > 0);
  if (textual.length === 0) return null;
  const w = wanted(false, textual.map(({ m }) => wordSet(m)), textual.map(({ m }) => endingList(m)));
  const labels = block.labelSelectors
    ? labelNodes(unit, adapter, block.labelSelectors, block.labelNodeLimit).map((n) => readLabel(n, unit, cache, w))
    : adapterLabels;
  // A social line ("<Name> likes this") heads the card, so only the first label
  // counts for endings: a post body that says "everyone likes this" must not hide.
  // Resolved on demand: it costs style reads, and only a unit with such a line needs it.
  let first: string | undefined;
  let firstResolved = false;
  for (const { text: t } of labels) {
    // A label node this long is post text that a broad selector reached, not a
    // header: a line reading "Follow" inside it is the author's, not the site's.
    if (t.length > MAX_SUGGESTED_LABEL) continue;
    for (const { m, rule } of textual) {
      let hit = hasWordLine(t, wordSet(m));
      if (!hit && hasLineEnding(t, endingList(m))) {
        if (!firstResolved) {
          first = firstShown(labels, unit, cache);
          firstResolved = true;
        }
        hit = t === first;
      }
      if (hit) return { kind: 'label', category: 'suggested', detail: normaliseText(t).slice(0, MAX_LABEL_LEN), rule };
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
  // Form controls label every option with the same few ids (a LinkedIn poll's 62
  // <option>s share their label ids), so each distinct reference list is read once.
  const checked = new Set<string>();
  for (let i = 0; i < els.length && i < MAX_LABELLEDBY; i++) {
    const ref = els[i]!.getAttribute('aria-labelledby') ?? '';
    if (checked.has(ref)) continue;
    checked.add(ref);
    const ids = ref.split(/\s+/).filter(Boolean);
    // A name longer than the cap can't be a marker, so stop reading once past it:
    // sites point aria-labelledby at whole headers and post bodies, and a full
    // textContent of those was the second-largest cost of a decision on LinkedIn.
    let name = '';
    for (const id of ids) {
      const part = boundedText(doc.getElementById(id), MAX_LABELLEDBY_NAME - name.length);
      if (part === null) {
        name = '';
        break;
      }
      name = name ? `${name} ${part}` : part;
      if (name.length > MAX_LABELLEDBY_NAME) break;
    }
    if (name && name.length <= MAX_LABELLEDBY_NAME && isMarkerText(name)) return normaliseText(name);
  }
  return null;
}

const MAX_LABELLEDBY_NAME = 40;

/** An element's textContent, or null once it runs past `max` characters. */
function boundedText(el: Element | null, max: number): string | null {
  if (!el) return '';
  if (!el.firstElementChild) {
    const t = el.textContent ?? '';
    return t.length > max ? null : t;
  }
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let out = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    out += n.nodeValue ?? '';
    if (out.length > max) return null;
  }
  return out;
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
