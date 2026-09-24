import { normaliseText } from './fingerprint';
import { isAdClickUrl, hasMarkerLine, isMarkerText } from './rules/markers';
import type { Adapter } from './adapters/schema';
import type { UnitPayload } from './types';

const MAX_TEXT = 600;
const MAX_LABELS = 5;
const MAX_LABEL_LEN = 40;
const MAX_LINK_HOSTS = 5;

const CTA_TEXT = /^(shop now|buy now|learn more|install|install now|sign up|download|get offer|order now|book now|apply now|get started|subscribe|try (it )?(for )?free)$/i;

/** Visible text. innerText skips display:none decoy spans; textContent does not. */
export function visibleText(el: Element): string {
  const html = el as HTMLElement;
  return typeof html.innerText === 'string' ? html.innerText : (el.textContent ?? '');
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

/** Visible text of a node inside a unit; '' when the node is not rendered. */
function labelText(node: Element, unit: Element): string {
  return renderedWithin(node, unit) ? visibleText(node) : '';
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

/** Label nodes in document order, capped at the adapter's labelNodeLimit. */
function labelNodes(unit: Element, adapter: Adapter): Element[] {
  if (adapter.labelSelectors.length === 0) return [];
  const nodes = safeQueryAll(unit, adapter.labelSelectors.join(', '));
  return adapter.labelNodeLimit ? nodes.slice(0, adapter.labelNodeLimit) : nodes;
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

export function unitText(unit: Element, adapter: Adapter | null): string {
  const root = adapter?.textRootSelector ? (unit.querySelector(adapter.textRootSelector) ?? unit) : unit;
  return normaliseText(visibleText(root));
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

export type MarkerHit = { kind: 'structural' | 'label' | 'aria' | 'rel' | 'ad-link'; detail: string };

/**
 * Tier 0 marker detection for one unit. Returns the first hit, or null.
 * Cheap checks first; innerText (which forces layout) last.
 */
export function detectMarker(unit: Element, adapter: Adapter | null, base: string): MarkerHit | null {
  for (const sel of adapter?.adSelectors ?? []) {
    if (safeMatches(unit, sel) || safeQueryAll(unit, sel).length > 0) return { kind: 'structural', detail: sel };
  }
  for (const a of safeQueryAll(unit, 'a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (isAdClickUrl(href, base)) return { kind: 'ad-link', detail: new URL(href, base).hostname };
    if ((a.getAttribute('rel') ?? '').split(/\s+/).includes('sponsored')) return { kind: 'rel', detail: 'rel=sponsored' };
  }
  for (const el of safeQueryAll(unit, '[aria-label]')) {
    const v = el.getAttribute('aria-label') ?? '';
    if (isMarkerText(v)) return { kind: 'aria', detail: v };
  }
  if (adapter) {
    for (const node of labelNodes(unit, adapter)) {
      const t = labelText(node, unit);
      if (hasMarkerLine(t)) return { kind: 'label', detail: normaliseText(t).slice(0, MAX_LABEL_LEN) };
    }
  } else {
    const hit = genericLabelHit(unit);
    if (hit) return { kind: 'label', detail: hit };
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
    if (raw.length > 60) continue; // skip containers before paying for innerText
    if (!isMarkerText(raw)) continue; // cheap reject before paying for layout
    const t = labelText(el, unit);
    if (isMarkerText(t)) return normaliseText(t);
  }
  return null;
}
