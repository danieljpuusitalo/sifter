// Where hidden units sit relative to the viewport, so a hide never moves the feed
// under the reader.
//
// A hide lands as a veil: the unit's content stops painting, but its box keeps its
// exact height (hider.ts). This tracker tells the Hider when a veiled unit is off
// screen, and so when its height may change:
//
// - below the viewport: at once. Nothing on screen sits below it.
// - above the viewport: once scrolling has stopped, in one frame, with the move
//   measured and undone by a scroll. Chrome's scroll anchoring would undo it
//   too, but later than the read that follows the collapse; the scroll lands
//   first and replaces it (the e2e holds the screen within 1 px with anchoring
//   on, and fails without the scroll when a page sets `overflow-anchor: none`).
//   Sites that move their own slots get no anchoring at all.
//
// Zones come from an IntersectionObserver, which reports after layout and never
// forces one (hard rule 7). Only the above-viewport flush reads layout: two rect
// reads per batch, in an idle frame after the gesture ended.

export type VeilStats = {
  /** Hides whose unit was on screen (or within the margin) when first measured. */
  hidesInView: number;
  hidesAbove: number;
  hidesBelow: number;
  /** Veils turned into the user's hide mode once off screen. */
  veilsSettled: number;
  /** Above-viewport collapses the browser did not anchor, corrected with a scroll. */
  anchorCorrections: number;
};

export const EMPTY_VEIL_STATS: VeilStats = {
  hidesInView: 0,
  hidesAbove: 0,
  hidesBelow: 0,
  veilsSettled: 0,
  anchorCorrections: 0,
};

export interface VeilTracker {
  /** Start watching a veiled unit; `settle` is called once it may change height. */
  watch(unit: Element): void;
  /** Stop watching (the unit was settled, shown, unhidden or left the page). */
  unwatch(unit: Element): void;
  stats(): VeilStats;
  disconnect(): void;
}

export type VeilTrackerFactory = (settle: (unit: Element) => void) => VeilTracker;

/** A unit this close to the viewport still counts as on screen. */
const MARGIN_PX = 64;
/** Scrolling counts as over this long after the last scroll event, if `scrollend` never comes. */
const SCROLL_IDLE_MS = 150;
/** Below this, a measured move is rounding. */
const MOVE_EPSILON_PX = 0.5;

type Zone = 'in' | 'above' | 'below';

/** The real tracker, or undefined where the page has no IntersectionObserver (then hides apply at once, as before). */
export function viewportTracker(win: Window & typeof globalThis): VeilTrackerFactory | undefined {
  if (typeof win.IntersectionObserver !== 'function' || typeof win.requestAnimationFrame !== 'function') return undefined;
  return (settle) => new ViewportTracker(win, settle);
}

/**
 * Which side of the reader a unit is on. Not intersecting is not the same as outside
 * the window: a feed that scrolls inside an element (LinkedIn's <main>) clips a unit
 * that went up behind the header while its box still reaches below the window's top.
 * So a unit off screen is placed by the window's middle, and one that straddles it
 * while clipped counts as on screen (it stays veiled; nothing moves).
 */
export function zoneOf(e: IntersectionObserverEntry): Zone {
  if (e.isIntersecting) return 'in';
  const r = e.boundingClientRect;
  // No box at all (inside a hidden subtree, or detached): changing it moves nothing on screen.
  if (r.width === 0 && r.height === 0) return 'below';
  const root = e.rootBounds;
  if (!root) return r.bottom <= -MARGIN_PX ? 'above' : 'below';
  const mid = (root.top + root.bottom) / 2;
  if (r.bottom <= mid) return 'above';
  if (r.top >= mid) return 'below';
  return 'in';
}

class ViewportTracker implements VeilTracker {
  private readonly io: IntersectionObserver;
  private readonly watched = new Set<Element>();
  /** Watched units not yet measured once: their first zone is counted in the stats. */
  private readonly fresh = new Set<Element>();
  /** Off screen through the top, waiting for scrolling to stop. */
  private readonly above = new Set<Element>();
  /** Elements that fired a scroll event: the candidate scroll containers of a unit. */
  private readonly scrollers = new Set<Element>();
  private scrolling = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private readonly s: VeilStats = { ...EMPTY_VEIL_STATS };

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly settle: (unit: Element) => void,
  ) {
    this.io = new win.IntersectionObserver((entries) => this.onEntries(entries), { rootMargin: `${MARGIN_PX}px 0px` });
    const doc = win.document;
    // Capture: element scroll events do not bubble, but they do pass through the document.
    doc.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    doc.addEventListener('scrollend', this.onScrollEnd, { capture: true, passive: true });
  }

  watch(unit: Element): void {
    if (this.watched.has(unit)) return;
    this.watched.add(unit);
    this.fresh.add(unit);
    this.io.observe(unit);
  }

  unwatch(unit: Element): void {
    if (!this.watched.delete(unit)) return;
    this.fresh.delete(unit);
    this.above.delete(unit);
    this.io.unobserve(unit);
  }

  stats(): VeilStats {
    return { ...this.s };
  }

  disconnect(): void {
    this.io.disconnect();
    const doc = this.win.document;
    doc.removeEventListener('scroll', this.onScroll, { capture: true });
    doc.removeEventListener('scrollend', this.onScrollEnd, { capture: true });
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.watched.clear();
    this.fresh.clear();
    this.above.clear();
    this.scrollers.clear();
  }

  private readonly onScroll = (e: Event): void => {
    this.scrolling = true;
    const t = e.target as Node | null;
    if (t && t.nodeType === 1) this.scrollers.add(t as Element);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(this.onScrollEnd, SCROLL_IDLE_MS);
  };

  private readonly onScrollEnd = (): void => {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.scrolling = false;
    this.schedule();
  };

  private onEntries(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const unit = e.target;
      if (!this.watched.has(unit)) continue;
      const zone = zoneOf(e);
      if (this.fresh.delete(unit)) {
        if (zone === 'in') this.s.hidesInView++;
        else if (zone === 'above') this.s.hidesAbove++;
        else this.s.hidesBelow++;
      }
      if (zone === 'in') this.above.delete(unit);
      else if (zone === 'below') this.finish(unit);
      else this.above.add(unit);
    }
    this.schedule();
  }

  private finish(unit: Element): void {
    this.unwatch(unit);
    this.s.veilsSettled++;
    this.settle(unit);
  }

  private schedule(): void {
    if (this.frame !== undefined || this.scrolling || this.above.size === 0) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = undefined;
      this.flushAbove();
    });
  }

  /** The innermost element that scrolled and contains `unit`; null means the page itself. */
  private scrollerOf(unit: Element): Element | null {
    let best: Element | null = null;
    for (const s of this.scrollers) {
      if (!s.isConnected) {
        this.scrollers.delete(s);
        continue;
      }
      if (s.contains(unit) && (!best || best.contains(s))) best = s;
    }
    return best;
  }

  /**
   * Collapse every unit waiting above the viewport, in one frame, and undo any move.
   * Everything on screen sits below the lowest collapsing unit, so its bottom edge
   * moves exactly as far as the content the reader is looking at.
   */
  private flushAbove(): void {
    if (this.scrolling || this.above.size === 0) return;
    const groups = new Map<Element | null, Element[]>();
    for (const u of this.above) {
      if (!u.isConnected) {
        this.unwatch(u);
        continue;
      }
      const s = this.scrollerOf(u);
      const g = groups.get(s);
      if (g) g.push(u);
      else groups.set(s, [u]);
    }
    const marks: { scroller: Element | null; lowest: Element; before: number }[] = [];
    for (const [scroller, units] of groups) {
      let lowest: Element | null = null;
      let before = -Infinity;
      for (const u of units) {
        const b = u.getBoundingClientRect().bottom;
        if (!lowest || b > before) {
          before = b;
          lowest = u;
        }
      }
      if (lowest) marks.push({ scroller, lowest, before });
    }
    for (const units of groups.values()) for (const u of units) this.finish(u);
    for (const m of marks) {
      const delta = m.lowest.getBoundingClientRect().bottom - m.before;
      if (Math.abs(delta) <= MOVE_EPSILON_PX) continue;
      // `instant`: a page with `scroll-behavior: smooth` would otherwise animate the correction into view.
      const opts: ScrollToOptions = { top: delta, behavior: 'instant' };
      if (m.scroller) m.scroller.scrollBy(opts);
      else this.win.scrollBy(opts);
      this.s.anchorCorrections++;
    }
  }
}
