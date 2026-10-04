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
// - below the screen: past the visible bottom edge by a lead, checked with a fresh
//   rect in the next animation frame, scrolling or not. Nothing the reader can see
//   sits below it, so the collapse moves nothing they can see. The lead covers the
//   compositor scrolling ahead of the main thread: at least `MIN_LEAD_PX`, more the
//   faster the unit moves (session 18b: waiting for a still frame two screens away
//   let every tag reach the reader of a continuous scroll, 20 of 90 on LinkedIn).
//   A tag that later ends up below (the reader scrolled back up) collapses then.
// - pinned in a side column: Facebook's sticky rail never scrolls away, so its
//   sponsored module collapses at the first look, where it is: the feed is in
//   another column.
//
// Above the viewport, and anywhere on screen, a tag stays a tag. There is no
// above-viewport collapse and no scroll correction: those moved the feed under
// the reader no matter how carefully they were timed (sessions 15-17).
//
// Zones come from an IntersectionObserver, which reports after layout and never
// forces one (hard rule 7). The flush reads layout only in an animation frame,
// before any write: one rect read per tag waiting below, and the pinned-box style
// walk once per tag at its first look on screen, in a still frame.

export type LateStats = {
  /** Hides applied at once, with no tag, because the page was still loading (see `loadHide`). */
  hidesAtLoad: number;
  /** Late catches on screen, above it, or within the lead below at the first look: tagged in place. */
  lateInView: number;
  /** Late catches past the lead below the screen at the first look: collapsed at once. */
  lateFarBelow: number;
  /** Tags collapsed later, once they were past the lead below (the reader scrolled back up). */
  tagsCollapsed: number;
  /** Of `lateFarBelow` and `tagsCollapsed`, those collapsed while the page was scrolling. */
  collapsedMidScroll: number;
  /** Tags in a pinned side column (Facebook's rail), collapsed at the first look. */
  railCollapsed: number;
  /** Units reported below whose fresh rect was within the lead: each would have been a jump. */
  belowCameNear: number;
  /**
   * Tags off the real screen at their first report that the reader then scrolled onto
   * it. While a tag was a plain pill, each was an ad the reader could read: exposure
   * the hide-latency trace misses, because the post was off screen at the hide.
   */
  tagsScrolledIn: number;
};

export const EMPTY_LATE_STATS: LateStats = {
  hidesAtLoad: 0,
  lateInView: 0,
  lateFarBelow: 0,
  tagsCollapsed: 0,
  collapsedMidScroll: 0,
  railCollapsed: 0,
  belowCameNear: 0,
  tagsScrolledIn: 0,
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

/** Why a tag was settled: far below at its first look, below later, or in a pinned rail. */
export type SettleWhy = 'farBelow' | 'tagCollapsed' | 'rail';

/** Trace builds only: the tracker's own main-thread time, which the scanner's counters do not see. */
export type LateTrackerHooks = { cost?(kind: 'flush' | 'io', ms: number): void };

export type LateTrackerFactory = (settle: (unit: Element, why?: SettleWhy) => void, hooks?: LateTrackerHooks) => LateTracker;

/** A unit this close above the viewport still counts as on screen. */
const MARGIN_PX = 64;
/** A tag below the screen collapses only this far past its bottom edge, at least. */
export const MIN_LEAD_PX = 120;
/** And at least as far as it moves in this long: six frames of the compositor running ahead. */
export const LEAD_MS = 100;
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
  return (settle, hooks) => new ViewportTracker(win, settle, hooks?.cost);
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
   * Reported below the screen: checked again with a fresh rect in the next frame.
   * The report can be well over 100 ms old on a busy page, and a compositor scroll
   * does not wait for it. A unit still within the lead stays here and is looked at
   * again every frame the page scrolls: the observer has no margin below, so it
   * says nothing more until the unit comes onto the screen.
   */
  private readonly farPending = new Set<Element>();
  /** Each pending unit's last known top and when: its speed, without reading the scroll offset. */
  private readonly lastSeen = new WeakMap<Element, { top: number; at: number }>();
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
  /** The real screen, no margin: only counts `tagsScrolledIn`. */
  private readonly screen: IntersectionObserver;
  /** Watched tags whose first screen report has not come yet, and those it found off screen. */
  private readonly screenFirst = new Set<Element>();
  private readonly offScreenAtFirst = new Set<Element>();

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly settle: (unit: Element, why?: SettleWhy) => void,
    private readonly cost?: (kind: 'flush' | 'io', ms: number) => void,
  ) {
    // No margin below: anything past the screen's bottom edge is "below".
    this.io = new win.IntersectionObserver((entries) => this.timed('io', () => this.onEntries(entries)), { rootMargin: `${MARGIN_PX}px 0px 0px 0px` });
    this.screen = new win.IntersectionObserver((entries) => this.timed('io', () => this.onScreenEntries(entries)));
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
    this.screenFirst.add(unit);
    this.screen.observe(unit);
  }

  unwatch(unit: Element): void {
    if (!this.watched.delete(unit)) return;
    this.screen.unobserve(unit);
    this.screenFirst.delete(unit);
    this.offScreenAtFirst.delete(unit);
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
    this.screen.disconnect();
    this.screenFirst.clear();
    this.offScreenAtFirst.clear();
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
    this.schedule();
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
        if (typeof e.time === 'number') this.lastSeen.set(unit, { top: e.boundingClientRect.top, at: e.time });
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

  private onScreenEntries(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const unit = e.target;
      if (!this.watched.has(unit)) continue;
      if (this.screenFirst.delete(unit)) {
        if (e.isIntersecting) this.screen.unobserve(unit);
        else this.offScreenAtFirst.add(unit);
      } else if (e.isIntersecting && this.offScreenAtFirst.delete(unit)) {
        this.s.tagsScrolledIn++;
        this.screen.unobserve(unit);
      }
    }
  }

  private schedule(): void {
    if (this.frame !== undefined) return;
    // The rail check waits for a still frame; a tag below does not.
    if (this.farPending.size === 0 && (this.scrolling || this.firstInView.size === 0)) return;
    this.frame = this.win.requestAnimationFrame((t) => {
      this.frame = undefined;
      this.timed('flush', () => this.flush(t));
    });
  }

  /** Runs `fn`, timing it only in a trace build (no hook, no clock read). */
  private timed(kind: 'flush' | 'io', fn: () => void): void {
    if (!this.cost) return fn();
    const t0 = performance.now();
    fn();
    this.cost(kind, performance.now() - t0);
  }

  /** Reads first, then writes: every collapse lands in one frame, after every rect was read. */
  private flush(now: number): void {
    const collapse: [Element, SettleWhy][] = [];
    const bottom = this.win.innerHeight;
    let heldBySpeed = false;
    for (const u of this.farPending) {
      if (!u.isConnected) {
        this.unwatch(u);
        continue;
      }
      const first = this.firstLook.delete(u);
      const r = u.getBoundingClientRect();
      const lead = Math.max(MIN_LEAD_PX, this.speedOf(u, r.top, now) * LEAD_MS);
      // No box at all (inside a hidden subtree): collapsing it moves nothing on screen.
      if (r.top >= bottom + lead || (r.width === 0 && r.height === 0)) {
        if (first) this.s.lateFarBelow++;
        else this.s.tagsCollapsed++;
        if (this.scrolling) this.s.collapsedMidScroll++;
        collapse.push([u, first ? 'farBelow' : 'tagCollapsed']);
        continue;
      }
      // Within the lead: it stays tagged, and is looked at again next frame the page
      // scrolls, or next frame anyway if only its speed held it (it may have stopped).
      if (r.top >= bottom + MIN_LEAD_PX) heldBySpeed = true;
      if (first) {
        this.s.lateInView++;
        this.s.belowCameNear++;
      }
    }
    if (!this.scrolling) {
      for (const u of this.firstInView) {
        if (u.isConnected && this.sideColumnOf(u)) {
          this.s.railCollapsed++;
          collapse.push([u, 'rail']);
        }
      }
      this.firstInView.clear();
    }
    for (const [u, why] of collapse) {
      this.unwatch(u);
      this.settle(u, why);
    }
    if (heldBySpeed) this.schedule();
  }

  /**
   * How fast the unit moves up the screen, toward the reader, in px/ms, from its last
   * known top. Moving down (the reader scrolling back up) takes it further away, which
   * a compositor running ahead only adds to. Zero without a sample, or with a stale
   * one (the page sat still in between).
   */
  private speedOf(u: Element, top: number, now: number): number {
    const prev = this.lastSeen.get(u);
    this.lastSeen.set(u, { top, at: now });
    if (!prev) return 0;
    const dt = now - prev.at;
    return dt > 0 && dt < 500 ? Math.max(0, prev.top - top) / dt : 0;
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
