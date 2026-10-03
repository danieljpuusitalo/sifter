// What happens to a hide decided after the post was drawn. The rule is simple:
// never move what the reader can see.
//
// Most hides never get here: the pre-paint lane (scanner.ts) hides a post in the
// same mutation callback that added it, before its first paint. A hide decided
// later lands as a tag (hider.ts): the post stays exactly where it is, with a
// zero-height "Sponsored · Hide" pill on top. This tracker says when a tag may
// become the real hide after all:
//
// - while the page is still loading (`loadHide`): nobody is reading yet, and the
//   site itself is still moving things, so the hide applies at once.
// - far below: a full screen or more under the reader, checked with a fresh rect in
//   a still frame. Nothing the reader can see sits below it. A tag that later ends
//   up that far below (the reader scrolled back up) collapses then.
// - pinned in a side column: Facebook's sticky rail never scrolls away, so its
//   sponsored module collapses at the first look, where it is: the feed is in
//   another column.
//
// Above the viewport, and anywhere on screen, a tag stays a tag. There is no
// above-viewport collapse and no scroll correction: those moved the feed under
// the reader no matter how carefully they were timed (sessions 15-17).
//
// Zones come from an IntersectionObserver, which reports after layout and never
// forces one (hard rule 7). The flush reads layout only in an idle frame after
// the gesture ended: one rect read per unit reported below, and the pinned-box
// style walk once per tag at its first look on screen.

export type LateStats = {
  /** Hides applied at once, with no tag, because the page was still loading (see `loadHide`). */
  hidesAtLoad: number;
  /** Late catches on screen, above it, or within a screen below at the first look: tagged in place. */
  lateInView: number;
  /** Late catches a full screen or more below at the first look: collapsed at once. */
  lateFarBelow: number;
  /** Tags collapsed later, once the reader had left them a full screen behind. */
  tagsCollapsed: number;
  /** Tags in a pinned side column (Facebook's rail), collapsed at the first look. */
  railCollapsed: number;
  /** Units reported below whose fresh rect was nearer than a screen: each would have been a jump. */
  belowCameNear: number;
};

export const EMPTY_LATE_STATS: LateStats = {
  hidesAtLoad: 0,
  lateInView: 0,
  lateFarBelow: 0,
  tagsCollapsed: 0,
  railCollapsed: 0,
  belowCameNear: 0,
};

export interface LateTracker {
  /** Start watching a tagged unit; `settle` is called once it may change height. */
  watch(unit: Element): void;
  /** Stop watching (the unit was settled, shown, unhidden or left the page). */
  unwatch(unit: Element): void;
  stats(): LateStats;
  disconnect(): void;
  /**
   * Whether a new hide may skip the tag and take its real mode at once, because
   * the page is still loading: the reader has not scrolled or touched it yet, and
   * the site itself is still moving things. Counts the hide when it says yes.
   * Optional: without it every late hide is tagged.
   */
  loadHide?(): boolean;
}

export type LateTrackerFactory = (settle: (unit: Element) => void) => LateTracker;

/** A unit this close above the viewport still counts as on screen. */
const MARGIN_PX = 64;
/** Scrolling counts as over this long after the last scroll event, if `scrollend` never comes. */
const SCROLL_IDLE_MS = 150;
/**
 * The load window: until the reader's first gesture, or this long after
 * DOMContentLoaded, a hide collapses at once instead of tagging. Ended early by any
 * gesture or scroll.
 */
export const LOAD_GRACE_MS = 3000;
/** Anything the reader does that means they have found their place on the page. */
const GESTURES = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

type Zone = 'in' | 'above' | 'below';

/** The real tracker, or undefined where the page has no IntersectionObserver (then hides apply at once). */
export function viewportTracker(win: Window & typeof globalThis): LateTrackerFactory | undefined {
  if (typeof win.IntersectionObserver !== 'function' || typeof win.requestAnimationFrame !== 'function') return undefined;
  return (settle) => new ViewportTracker(win, settle);
}

/**
 * Which side of the observed band a unit is on. Not intersecting is not the same as
 * outside the window: a feed that scrolls inside an element (LinkedIn's <main>) clips
 * a unit that went up behind the header while its box still reaches below the
 * window's top. So a unit off the band is placed by the band's middle, and one that
 * straddles it while clipped counts as on screen.
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

class ViewportTracker implements LateTracker {
  private readonly io: IntersectionObserver;
  private readonly watched = new Set<Element>();
  /** Watched units not yet measured once: their first look is counted in the stats. */
  private readonly fresh = new Set<Element>();
  /**
   * Reported below the observed band: checked again with a fresh rect in a still
   * frame. The report can be well over 100 ms old on a busy page, and a compositor
   * scroll does not wait for it. A unit still nearer than a screen stays here and is
   * looked at again after the next scroll: in a feed that scrolls inside an element
   * the observer reports it once, when it leaves that element, and never again.
   */
  private readonly farPending = new Set<Element>();
  /** Units in `farPending` whose first look has not been counted yet. */
  private readonly firstLook = new Set<Element>();
  /** Reported on screen at the first look: checked once for a pinned side column. */
  private readonly firstInView = new Set<Element>();
  /** Each looked-at unit's fixed or sticky ancestor (null: none). */
  private readonly pinnedBox = new WeakMap<Element, Element | null>();
  private scrolling = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private readonly s: LateStats = { ...EMPTY_LATE_STATS };
  /** True until the reader's first gesture or `LOAD_GRACE_MS`: see `loadHide`. */
  private grace = true;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly settle: (unit: Element) => void,
  ) {
    // The band reaches a full screen below the window: anything outside it below is "far".
    this.io = new win.IntersectionObserver((entries) => this.onEntries(entries), { rootMargin: `${MARGIN_PX}px 0px 100% 0px` });
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
    this.farPending.delete(unit);
    this.firstLook.delete(unit);
    this.firstInView.delete(unit);
    this.io.unobserve(unit);
  }

  stats(): LateStats {
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
    this.farPending.clear();
    this.firstLook.clear();
    this.firstInView.clear();
  }

  private readonly onScroll = (): void => {
    // Any scroll ends the load window, the site's own included: once the page sits
    // somewhere other than its top, a collapse on screen moves what the reader sees.
    this.endGrace();
    this.scrolling = true;
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
      const first = this.fresh.delete(unit);
      if (zone === 'below') {
        // Never collapsed from the report itself: see `farPending`.
        this.farPending.add(unit);
        if (first) this.firstLook.add(unit);
        continue;
      }
      this.farPending.delete(unit);
      if (this.firstLook.delete(unit) || first) {
        this.s.lateInView++;
        if (zone === 'in') this.firstInView.add(unit);
      }
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== undefined || this.scrolling || (this.farPending.size === 0 && this.firstInView.size === 0)) return;
    // Two frames: `scrollend` fires in the same frame as the last scroll, before its
    // animation callbacks; a frame later the scroll offset has caught up.
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = undefined;
        this.flush();
      });
    });
  }

  /** Reads first, then writes: every collapse lands in one frame, after every rect was read. */
  private flush(): void {
    if (this.scrolling) return;
    const collapse: Element[] = [];
    const far = this.win.innerHeight * 2;
    for (const u of this.farPending) {
      if (!u.isConnected) {
        this.unwatch(u);
        continue;
      }
      const first = this.firstLook.delete(u);
      const r = u.getBoundingClientRect();
      // No box at all (inside a hidden subtree): collapsing it moves nothing on screen.
      if (r.top >= far || (r.width === 0 && r.height === 0)) {
        if (first) this.s.lateFarBelow++;
        else this.s.tagsCollapsed++;
        collapse.push(u);
        continue;
      }
      // Nearer than a screen: it stays tagged, and is looked at again after the next scroll.
      if (first) {
        this.s.lateInView++;
        this.s.belowCameNear++;
      }
    }
    for (const u of this.firstInView) {
      if (u.isConnected && this.sideColumnOf(u)) {
        this.s.railCollapsed++;
        collapse.push(u);
      }
    }
    this.firstInView.clear();
    for (const u of collapse) {
      this.unwatch(u);
      this.settle(u);
    }
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
}
