// Where hidden units sit relative to the viewport, so a hide never moves the feed
// under the reader.
//
// A hide lands as a veil: the unit's content stops painting, but its box keeps its
// exact height (hider.ts). This tracker tells the Hider when a veiled unit is off
// screen, and so when its height may change:
//
// - below the viewport: at the next still frame, if a fresh rect still puts it
//   there. Nothing on screen sits below it.
// - above the viewport: once scrolling has stopped, in one frame, with the move
//   measured and undone by a scroll. Chrome's scroll anchoring would undo it
//   too, but later than the read that follows the collapse; the scroll lands
//   first and replaces it (the e2e holds the screen within 1 px with anchoring
//   on, and fails without the scroll when a page sets `overflow-anchor: none`).
//   Sites that move their own slots get no anchoring at all.
// - on screen, but pinned: a unit in a sticky rail (Facebook's) never leaves the
//   screen, so it would stay a blank hole under its bar for good. In a fixed or
//   sticky side column (at most half the window wide; a wider one is the feed)
//   it collapses at the first look, right after the hide, where it is: the feed
//   is in another column.
// - on screen, top under the header: the bar has scrolled up behind a fixed
//   header, leaving blank space with nothing to say why. It collapses like a unit
//   above the viewport: everything below its bottom edge holds still.
//
// Zones come from an IntersectionObserver, which reports after layout and never
// forces one (hard rule 7). Only the flush reads layout, in an idle frame after
// the gesture ended: two rect reads per batch above the viewport (a third, and a
// retry, only when a correction missed), one rect read per unit reported below,
// and one rect
// and scroll-offset read per on-screen veil whose page has scrolled since. The one
// computed-style read is the pinned-box walk, once per on-screen veil.

export type VeilStats = {
  /** Hides whose unit was on screen (or within the margin) when first measured. */
  hidesInView: number;
  hidesAbove: number;
  hidesBelow: number;
  /** Veils turned into the user's hide mode once off screen. */
  veilsSettled: number;
  /** Above-viewport collapses the browser did not anchor, corrected with a scroll. */
  anchorCorrections: number;
  /** Corrections that left the reader's content more than a pixel off (the scroll fell short or overshot). */
  correctionMisses: number;
  /** The largest such miss, in px. */
  maxCorrectionMissPx: number;
  /** Misses where the scroller did not move the full amount (clamped or absorbed); a retry cannot help. */
  correctionsClamped: number;
  /** Misses where the scroll landed but the layout moved again; corrected once more. */
  correctionRetries: number;
  /** Retries that still left the content more than a pixel off. */
  retryMisses: number;
  /** On-screen veils settled because a scroll did not move them (a sticky rail). */
  veilsPinned: number;
  /** On-screen veils settled because their top (and bar) went up under the header. */
  veilsUnderTop: number;
  /** Units reported below the viewport, whose collapse waited for a fresh look in a still frame. */
  belowDeferred: number;
  /** Of those, the ones that had reached the screen by then: each would have been a jump (live report D). */
  belowCameInView: number;
  /** Hides applied at once, with no veil, because the page was still loading (see `loadHide`). */
  hidesAtLoad: number;
};

export const EMPTY_VEIL_STATS: VeilStats = {
  hidesInView: 0,
  hidesAbove: 0,
  hidesBelow: 0,
  veilsSettled: 0,
  anchorCorrections: 0,
  correctionMisses: 0,
  maxCorrectionMissPx: 0,
  correctionsClamped: 0,
  correctionRetries: 0,
  retryMisses: 0,
  veilsPinned: 0,
  veilsUnderTop: 0,
  belowDeferred: 0,
  belowCameInView: 0,
  hidesAtLoad: 0,
};

export interface VeilTracker {
  /** Start watching a veiled unit; `settle` is called once it may change height. */
  watch(unit: Element): void;
  /** Stop watching (the unit was settled, shown, unhidden or left the page). */
  unwatch(unit: Element): void;
  stats(): VeilStats;
  disconnect(): void;
  /**
   * Whether a new hide may skip the veil and take its real mode at once, because
   * the page is still loading: the reader has not scrolled or touched it yet, and
   * the site itself is still moving things. Counts the hide when it says yes.
   * Optional: without it every hide is veiled.
   */
  loadHide?(): boolean;
}

export type VeilTrackerFactory = (settle: (unit: Element) => void) => VeilTracker;

/** A unit this close to the viewport still counts as on screen. */
const MARGIN_PX = 64;
/** Scrolling counts as over this long after the last scroll event, if `scrollend` never comes. */
const SCROLL_IDLE_MS = 150;
/** Below this, a measured move is rounding. */
const MOVE_EPSILON_PX = 0.5;
/** A scroll this long that moves an on-screen unit by half as much or more means it moves with the page. */
const MOVING_SCROLL_PX = 48;
/** A unit whose top is above this line (window) has its bar under a fixed header (Facebook's is 56 px). */
const HEADER_BAND_PX = 64;
/** An under-top veil settles once no more than this much of it is still below the top edge. */
const UNDER_TOP_VISIBLE_PX = 48;
/** In a feed that scrolls inside an element, a top this far past the element's own top edge is clipped. */
const CLIP_BAND_PX = 8;
/**
 * The load window: until the reader's first gesture, or this long after
 * DOMContentLoaded, a hide collapses at once instead of veiling. A veil on a page
 * nobody has scrolled yet only leaves a hole at the top (Google's ad block left the
 * results stranded below it until a scroll, 2026-10-01). Ended early by any gesture.
 */
export const LOAD_GRACE_MS = 3000;
/** Anything the reader does that means they have found their place on the page. */
const GESTURES = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

type Zone = 'in' | 'above' | 'below';

/** Where an on-screen veil was, and how far its scrollers had scrolled, at the last look. */
type Seen = { top: number; offset: number; scroller: Element | null; seq: number; moves: boolean };

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
 * while clipped counts as on screen (the flush then checks its top edge).
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
  /**
   * Reported below the viewport: checked again with a fresh rect in the flush, in an
   * animation frame once scrolling has stopped. The report can be well over 100 ms
   * old on a busy page (LinkedIn's main thread is 50-80% busy), and a compositor
   * scroll does not wait for it, so the unit may already be on screen. Collapsing it
   * then pulls everything under it up by its whole height: the 730-870 px jumps of
   * live report D. Not only mid-scroll: while a long site task blocks the main
   * thread no scroll event arrives, so the page looks still while the compositor
   * scrolls on (an 881 px jump on 2026-10-01, with `belowDeferred` at 0). An
   * animation frame runs after the frame's scroll offset has caught up.
   */
  private readonly belowPending = new Set<Element>();
  /** On screen: where each was at the last look (null: not looked at yet). */
  private readonly onScreen = new Map<Element, Seen | null>();
  /** Counts scroll events, so a look is only repeated after something scrolled. */
  private scrollSeq = 0;
  /** Each looked-at unit's fixed or sticky ancestor (null: none). */
  private readonly pinnedBox = new WeakMap<Element, Element | null>();
  /** Elements that fired a scroll event: the candidate scroll containers of a unit. */
  private readonly scrollers = new Set<Element>();
  private scrolling = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private readonly s: VeilStats = { ...EMPTY_VEIL_STATS };
  /** True until the reader's first gesture or `LOAD_GRACE_MS`: see `loadHide`. */
  private grace = true;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly settle: (unit: Element) => void,
  ) {
    this.io = new win.IntersectionObserver((entries) => this.onEntries(entries), { rootMargin: `${MARGIN_PX}px 0px` });
    const doc = win.document;
    // Capture: element scroll events do not bubble, but they do pass through the document.
    doc.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    doc.addEventListener('scrollend', this.onScrollEnd, { capture: true, passive: true });
    for (const g of GESTURES) doc.addEventListener(g, this.endGrace, { capture: true, passive: true });
    // The content script starts at document_start, seconds before a feed has drawn
    // anything: the clock runs from DOMContentLoaded, so the window is not spent on a blank page.
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', this.startGraceClock, { once: true });
    else this.startGraceClock();
  }

  private readonly startGraceClock = (): void => {
    if (this.grace) this.graceTimer = setTimeout(this.endGrace, LOAD_GRACE_MS);
  };

  loadHide(): boolean {
    if (!this.grace) return false;
    this.s.hidesAtLoad++;
    return true;
  }

  private readonly endGrace = (): void => {
    if (!this.grace) return;
    this.grace = false;
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    const doc = this.win.document;
    for (const g of GESTURES) doc.removeEventListener(g, this.endGrace, { capture: true });
    doc.removeEventListener('DOMContentLoaded', this.startGraceClock);
  };

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
    this.belowPending.delete(unit);
    this.onScreen.delete(unit);
    this.io.unobserve(unit);
  }

  stats(): VeilStats {
    return { ...this.s };
  }

  disconnect(): void {
    this.endGrace();
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
    this.belowPending.clear();
    this.onScreen.clear();
    this.scrollers.clear();
  }

  private readonly onScroll = (e: Event): void => {
    // Any scroll ends the load window, the site's own included: once the page sits
    // somewhere other than its top, a collapse on screen moves what the reader sees.
    this.endGrace();
    this.scrolling = true;
    this.scrollSeq++;
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
      if (zone !== 'below') this.belowPending.delete(unit);
      if (zone === 'in') {
        this.above.delete(unit);
        if (!this.onScreen.has(unit)) this.onScreen.set(unit, null);
      } else if (zone === 'below') {
        // Never collapsed from the report itself, scrolling or not: see `belowPending`.
        if (!this.belowPending.has(unit)) {
          this.above.delete(unit);
          this.onScreen.delete(unit);
          this.belowPending.add(unit);
          this.s.belowDeferred++;
        }
      } else {
        this.onScreen.delete(unit);
        this.above.add(unit);
      }
    }
    this.schedule();
  }

  private finish(unit: Element): void {
    this.unwatch(unit);
    this.s.veilsSettled++;
    this.settle(unit);
  }

  private schedule(): void {
    if (this.frame !== undefined || this.scrolling || (this.above.size === 0 && this.onScreen.size === 0 && this.belowPending.size === 0)) return;
    // Two frames: `scrollend` fires in the same frame as the last scroll, before its
    // animation callbacks, so one frame would collapse and correct before that scroll
    // painted. They would paint as one move with it, and the Layout Instability API
    // counts the whole collapse as a shift. A frame later the collapse and its
    // correction cancel out, on screen and in the API.
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = undefined;
        this.flush();
      });
    });
  }

  private flush(): void {
    if (this.scrolling) return;
    // Reads first, writes after: the pinned collapses land with the ones above.
    const below = this.lookBelow();
    const pinned = this.lookOnScreen();
    this.flushAbove(pinned);
    for (const u of below) this.finish(u);
  }

  /**
   * Where each unit reported below really is, now the page is still:
   * one rect read each, in the flush's read phase. Still below, it is returned to
   * collapse after everything else. One that reached the screen becomes an on-screen
   * veil, and one that went right past it waits above, like any other.
   */
  private lookBelow(): Element[] {
    const below: Element[] = [];
    for (const u of this.belowPending) {
      if (!u.isConnected) {
        this.unwatch(u);
        continue;
      }
      const r = u.getBoundingClientRect();
      if (r.top >= this.win.innerHeight + MARGIN_PX) {
        below.push(u);
        continue;
      }
      this.s.belowCameInView++;
      if (r.bottom <= -MARGIN_PX) this.above.add(u);
      else this.onScreen.set(u, null);
    }
    this.belowPending.clear();
    return below;
  }

  /**
   * Look again at each on-screen veil whose page has scrolled since the last look.
   * One in a pinned side column, at its first look, is returned, to collapse where
   * it is. One that moves with the page and has gone up under the header, all but its
   * last `UNDER_TOP_VISIBLE_PX`, joins the units above the viewport. Only a unit seen
   * moving may: collapsing a pinned one
   * and scrolling to undo the move would move the feed instead.
   */
  private lookOnScreen(): Element[] {
    const pinned: Element[] = [];
    for (const [u, seen] of this.onScreen) {
      if (!u.isConnected) {
        this.unwatch(u);
        continue;
      }
      if (seen && seen.seq === this.scrollSeq) continue;
      // A pinned side column (a sticky rail) may never scroll the unit away: collapse it
      // at the first look, right after the hide, as before veils. Only its own column
      // moves (a rail's lower modules), while the page is still settling in; after the
      // first scroll that move would come out of nowhere. Not "it stayed put through a
      // scroll" either: when something above collapses and a scroll undoes the move
      // (Sifter's own correction, or Chrome's anchoring), every feed card stays put too.
      if (!seen && this.sideColumnOf(u)) {
        pinned.push(u);
        this.onScreen.delete(u);
        continue;
      }
      const scroller = this.scrollerOf(u);
      const offset = this.win.scrollY + (scroller ? scroller.scrollTop : 0);
      const { top, bottom } = u.getBoundingClientRect();
      let moves = seen?.moves ?? false;
      if (seen && seen.scroller === scroller) {
        const scrolled = Math.abs(offset - seen.offset);
        const moved = Math.abs(top - seen.top);
        if (scrolled >= MOVING_SCROLL_PX && moved >= scrolled / 2) moves = true;
      }
      // Its top under the header is not enough: the collapse is corrected on its bottom
      // edge, so whatever of it was still on screen fills with the post above it, which
      // slides down that far. A tall veil just past the header made that a whole-screen
      // jump (855 and 869 px, live report D). Only once nearly all of it is gone.
      const edge = this.topEdge(scroller);
      if (moves && top < edge && bottom - edge <= UNDER_TOP_VISIBLE_PX) {
        this.onScreen.delete(u);
        this.above.add(u);
        this.s.veilsUnderTop++;
        continue;
      }
      this.onScreen.set(u, { top, offset, scroller, seq: this.scrollSeq, moves });
    }
    return pinned;
  }

  /**
   * The fixed or sticky box the unit sits in, if any. A style walk up its ancestors,
   * once per unit, in an idle frame after the gesture: not the scanner's mid-scroll
   * path (which never reads computed style outside `decide()`).
   */
  private pinnedBoxOf(u: Element): Element | null {
    let box = this.pinnedBox.get(u);
    if (box === undefined) {
      box = null;
      for (let e: Element | null = u; e; e = e.parentElement) {
        const p = this.win.getComputedStyle(e).position;
        if (p === 'fixed' || p === 'sticky') {
          box = e;
          break;
        }
      }
      this.pinnedBox.set(u, box);
    }
    return box;
  }

  /**
   * The unit's fixed or sticky box, if it is a side column: at most half the window
   * wide. A wider one is the feed itself, pinned in place while it scrolls inside
   * (LinkedIn's `<main>`), and its cards come and go like the page's.
   */
  private sideColumnOf(u: Element): Element | null {
    const box = this.pinnedBoxOf(u);
    return box && box.getBoundingClientRect().width <= this.win.innerWidth / 2 ? box : null;
  }

  /** Above this line a unit's bar cannot be seen: under a fixed header, or clipped by its scroller's top edge. */
  private topEdge(scroller: Element | null): number {
    return scroller ? Math.max(HEADER_BAND_PX, scroller.getBoundingClientRect().top + CLIP_BAND_PX) : HEADER_BAND_PX;
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
   * Collapse every unit waiting above the viewport (and the pinned ones), in one
   * frame, and undo any move. Everything the reader can see sits below the lowest
   * collapsing unit, so its bottom edge moves exactly as far as that content.
   */
  private flushAbove(pinned: Element[]): void {
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
    // A pinned unit is in its own column (a sticky rail): the feed does not move when it collapses.
    for (const u of pinned) {
      this.s.veilsPinned++;
      this.finish(u);
    }
    for (const units of groups.values()) for (const u of units) this.finish(u);
    for (const m of marks) {
      const delta = m.lowest.getBoundingClientRect().bottom - m.before;
      if (Math.abs(delta) <= MOVE_EPSILON_PX) continue;
      const applied = this.correct(m.scroller, delta);
      this.s.anchorCorrections++;
      // A scroll dirties no layout, so this read is cheap. A miss is a jump the reader
      // saw (live report D): either the scroller would not move that far, or it did and
      // the layout moved again under it (content coming into view at its real size).
      const left = m.lowest.getBoundingClientRect().bottom - m.before;
      if (Math.abs(left) <= 1) continue;
      this.s.correctionMisses++;
      this.s.maxCorrectionMissPx = Math.max(this.s.maxCorrectionMissPx, Math.round(Math.abs(left)));
      if (Math.abs(applied - delta) > 1) {
        this.s.correctionsClamped++;
        continue;
      }
      // Once only: a layout that keeps moving is the page's, not ours to chase.
      this.correct(m.scroller, left);
      this.s.correctionRetries++;
      if (Math.abs(m.lowest.getBoundingClientRect().bottom - m.before) > 1) this.s.retryMisses++;
    }
  }

  /** Scroll `scroller` (or the window) by `dy`, and return how far it actually moved. */
  private correct(scroller: Element | null, dy: number): number {
    const at = () => (scroller ? scroller.scrollTop : this.win.scrollY);
    const from = at();
    // `instant`: a page with `scroll-behavior: smooth` would otherwise animate the correction into view.
    const opts: ScrollToOptions = { top: dy, behavior: 'instant' };
    if (scroller) scroller.scrollBy(opts);
    else this.win.scrollBy(opts);
    return at() - from;
  }
}
