// Writes that change heights all over the page at once (pause, a category switched
// off, "Show all") must not move what the reader is looking at. The new-hide path
// has the veil for that; a release has nothing, so every hidden post above the
// screen expanded under the reader and the feed jumped (live report, 2026-10-01).
//
// The fix is the one `flushAbove` uses: note where something on screen sits, do the
// writes, and scroll back by however far it moved. That costs one forced layout, so
// it is only for passes the user started, never for the scroll-time path (hard rule 7).

/** Moves smaller than this are rounding, not a jump. */
const MOVE_EPSILON_PX = 0.5;
/** Where to look for the reader's anchor, as fractions of the window height. */
const PROBES = [0.25, 0.5, 0.75];

type Anchor = { el: Element; top: number; scroller: Element | null };

/**
 * Runs `writes`, then scrolls so the post at the reader's eye line is back where it
 * was. `isUnit` names the elements worth anchoring to (a post, hidden or not): a
 * post's top only moves when something above it changes, whatever happens inside it.
 * Returns the correction applied, in px (0: none was needed, or no anchor was found).
 */
export function keepInPlace(doc: Document, isUnit: (el: Element) => boolean, writes: () => void, feedRoot?: string): number {
  const anchor = findAnchor(doc, isUnit, feedRoot);
  writes();
  if (!anchor || !anchor.el.isConnected) return 0;
  const delta = anchor.el.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) <= MOVE_EPSILON_PX) return 0;
  // `instant`: a page with `scroll-behavior: smooth` would otherwise animate the correction into view.
  const opts: ScrollToOptions = { top: delta, behavior: 'instant' };
  if (anchor.scroller) anchor.scroller.scrollBy(opts);
  else doc.defaultView?.scrollBy(opts);
  return delta;
}

function findAnchor(doc: Document, isUnit: (el: Element) => boolean, feedRoot?: string): Anchor | null {
  const win = doc.defaultView;
  if (!win || typeof doc.elementFromPoint !== 'function') return null;
  const x = feedX(doc, win, feedRoot);
  for (const f of PROBES) {
    const hit = doc.elementFromPoint(x, win.innerHeight * f);
    let unit: Element | null = null;
    for (let el = hit; el && el !== doc.body; el = el.parentElement) if (isUnit(el)) unit = el;
    if (!unit) continue;
    // The outermost unit: a reshare's inner post moves with its outer one.
    return { el: unit, top: unit.getBoundingClientRect().top, scroller: scrollerOf(unit, win) };
  }
  return null;
}

/** The middle of the feed column (the adapter's feed root, else `main`); the window's middle without one. */
function feedX(doc: Document, win: Window, feedRoot?: string): number {
  let main: Element | null = null;
  try {
    main = doc.querySelector(feedRoot ?? 'main, [role="main"]');
  } catch {
    main = null;
  }
  const r = main?.getBoundingClientRect();
  return r && r.width > 0 ? r.left + r.width / 2 : win.innerWidth / 2;
}

/** The nearest ancestor that scrolls vertically; null means the page itself. */
function scrollerOf(el: Element, win: Window): Element | null {
  for (let p = el.parentElement; p && p !== el.ownerDocument.body && p !== el.ownerDocument.documentElement; p = p.parentElement) {
    if (p.scrollHeight <= p.clientHeight) continue;
    const o = win.getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'overlay') return p;
  }
  return null;
}
