import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_GRACE_MS, viewportTracker, type LateTracker } from '../../src/content/viewport';

// The tracker's three rules (load, far below, pinned rail), with the browser's
// parts faked: an IntersectionObserver that reports what the test says, frames run
// by hand, and units whose rects the test moves. Scrolling is a scroll event plus a
// new scrollY; a unit "moves with the page" only if the test moves its rect too.
// The rule the tests below keep proving: a tag the reader can see never collapses
// on its own, and nothing ever scrolls the page.

type Rect = { top: number; bottom: number };

class FakeIO {
  static last: FakeIO;
  constructor(readonly cb: (entries: IntersectionObserverEntry[]) => void) {
    FakeIO.last = this;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let frames: Array<() => void>;
let scrolls: number[];
let win: { scrollY: number };
let settled: Element[];
let tracker: LateTracker;
const rects = new Map<Element, Rect>();

/** A unit at `top`; `pinned` puts it in a sticky box that tall, `width` wide (a 300 px rail). */
function unit(top: number, height = 400, pinned?: number, width = 300): Element {
  const u = document.createElement('div');
  if (pinned !== undefined) {
    const rail = document.createElement('div');
    rail.dataset.pos = 'sticky';
    rail.getBoundingClientRect = () => ({ top: 0, bottom: pinned, height: pinned, width }) as DOMRect;
    rail.append(u);
    document.body.append(rail);
  } else document.body.append(u);
  rects.set(u, { top, bottom: top + height });
  u.getBoundingClientRect = () => {
    const r = rects.get(u)!;
    const h = r.bottom - r.top;
    return { top: r.top, bottom: r.bottom, left: 0, right: h ? 600 : 0, width: h ? 600 : 0, height: h, x: 0, y: r.top } as DOMRect;
  };
  return u;
}

/** The observer says `u` is on screen. */
function onScreen(u: Element): void {
  FakeIO.last.cb([{ target: u, isIntersecting: true, boundingClientRect: u.getBoundingClientRect(), rootBounds: null } as unknown as IntersectionObserverEntry]);
}

/** The observer says `u` is outside the band; its rect says which side. */
function outside(u: Element): void {
  FakeIO.last.cb([{ target: u, isIntersecting: false, boundingClientRect: u.getBoundingClientRect(), rootBounds: { top: 0, bottom: 800 } } as unknown as IntersectionObserverEntry]);
}

function runFrames(): void {
  while (frames.length) frames.shift()!();
}

/** Scroll the page by `dy`; units in `moving` move with it, the rest stay put. */
function scroll(dy: number, moving: Element[]): void {
  win.scrollY += dy;
  for (const u of moving) {
    const r = rects.get(u)!;
    rects.set(u, { top: r.top - dy, bottom: r.bottom - dy });
  }
  document.dispatchEvent(new Event('scroll'));
  document.dispatchEvent(new Event('scrollend'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  rects.clear();
  frames = [];
  scrolls = [];
  settled = [];
  const w = {
    IntersectionObserver: FakeIO,
    requestAnimationFrame: (f: () => void) => frames.push(f),
    cancelAnimationFrame: () => {},
    document,
    getComputedStyle: (e: Element) => ({ position: (e as HTMLElement).dataset?.pos ?? 'static' }),
    scrollY: 0,
    innerHeight: 800,
    innerWidth: 1200,
    // Nothing may call this: there is no scroll correction any more.
    scrollBy: (o: ScrollToOptions) => scrolls.push(o.top ?? 0),
  };
  win = w;
  const factory = viewportTracker(w as unknown as Window & typeof globalThis)!;
  tracker?.disconnect();
  tracker = factory((u) => {
    settled.push(u);
    // Settling collapses the unit to a 36 px bar.
    const r = rects.get(u)!;
    rects.set(u, { top: r.top, bottom: r.top + 36 });
  });
  // The tests below are about a page the reader is already scrolling.
  document.dispatchEvent(new Event('wheel'));
});

describe('viewport tracker, on screen and above: a tag stays a tag', () => {
  it('a tag on screen is never collapsed, however the page scrolls', () => {
    const u = unit(200);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(200, [u]);
    runFrames();
    // Up behind the header and past the top: the old veil settled here and corrected with a scroll.
    scroll(600, [u]);
    outside(u);
    runFrames();
    scroll(3000, [u]);
    runFrames();
    expect(settled).toEqual([]);
    expect(scrolls).toEqual([]);
    expect(tracker.stats()).toMatchObject({ lateInView: 1, lateFarBelow: 0, tagsCollapsed: 0 });
  });

  it('a late catch above the viewport at its first look is tagged, not collapsed', () => {
    const u = unit(-1500);
    tracker.watch(u);
    outside(u);
    runFrames();
    expect(settled).toEqual([]);
    expect(tracker.stats().lateInView).toBe(1);
  });
});

describe('viewport tracker, far below', () => {
  it('a late catch two screens or more below collapses at the next still frame', () => {
    const u = unit(2000);
    tracker.watch(u);
    outside(u);
    expect(settled, 'not from the report itself').toEqual([]);
    runFrames();
    expect(settled).toEqual([u]);
    expect(scrolls).toEqual([]);
    expect(tracker.stats()).toMatchObject({ lateFarBelow: 1, lateInView: 0, belowCameNear: 0 });
  });

  // Negative control for the threshold: the observer's band reaches a screen below the
  // window, but its report can be stale. A fresh rect nearer than that stays a tag.
  it('reported below but nearer than two screens: stays a tag, counted as one that came near', () => {
    const u = unit(1000);
    tracker.watch(u);
    outside(u);
    runFrames();
    expect(settled).toEqual([]);
    expect(tracker.stats()).toMatchObject({ lateFarBelow: 0, lateInView: 1, belowCameNear: 1 });
  });

  // 2026-10-01, 881 px: a long site task held every scroll event back, so the page
  // looked still while the compositor scrolled the unit onto the screen.
  it('with no scroll event at all, stays a tag if a fresh look finds it on screen', () => {
    const u = unit(2000);
    tracker.watch(u);
    outside(u);
    win.scrollY += 1500;
    rects.set(u, { top: 500, bottom: 900 });
    runFrames();
    expect(settled).toEqual([]);
    expect(tracker.stats().belowCameNear).toBe(1);
  });

  it('mid-scroll, waits for the scroll to stop and then looks again', () => {
    const u = unit(2000);
    tracker.watch(u);
    document.dispatchEvent(new Event('scroll'));
    outside(u);
    runFrames();
    expect(settled, 'not while the page is moving').toEqual([]);
    document.dispatchEvent(new Event('scrollend'));
    runFrames();
    expect(settled).toEqual([u]);
  });

  it('a near tag the reader leaves far behind (scrolling back up) collapses then', () => {
    const u = unit(1000);
    tracker.watch(u);
    outside(u);
    runFrames();
    expect(settled).toEqual([]);
    scroll(-1500, [u]);
    runFrames();
    expect(settled).toEqual([u]);
    expect(tracker.stats()).toMatchObject({ lateInView: 1, tagsCollapsed: 1, lateFarBelow: 0 });
  });

  it('a unit with no box collapses: changing it moves nothing', () => {
    const u = unit(300, 0);
    tracker.watch(u);
    outside(u);
    runFrames();
    expect(settled).toEqual([u]);
  });

  // `scrollend` fires in the scroll's own frame, before that frame paints: a collapse in
  // its first animation frame would paint together with the scroll, as one visible move.
  it('waits a frame after the scroll ends before it collapses anything', () => {
    const u = unit(1000);
    tracker.watch(u);
    outside(u);
    runFrames();
    scroll(-1500, [u]);
    frames.shift()!();
    expect(settled, 'nothing in the frame the scroll ended in').toEqual([]);
    runFrames();
    expect(settled).toEqual([u]);
  });

  it('a unit that left the page is dropped, not settled', () => {
    const u = unit(2000);
    tracker.watch(u);
    outside(u);
    u.remove();
    runFrames();
    expect(settled).toEqual([]);
  });
});

describe('viewport tracker, pinned side column', () => {
  it('a tag in a sticky box that fits the window (a rail) settles at the first look', () => {
    const rail = unit(70, 400, 700);
    const feed = unit(300);
    tracker.watch(rail);
    tracker.watch(feed);
    onScreen(rail);
    onScreen(feed);
    runFrames();
    expect(settled).toEqual([rail]);
    expect(scrolls).toEqual([]);
    expect(tracker.stats().railCollapsed).toBe(1);
  });

  // A rail taller than the window (the bench's) is still a side column.
  it('a tag in a sticky side column taller than the window settles at the first look too', () => {
    const rail = unit(70, 400, 2000);
    tracker.watch(rail);
    onScreen(rail);
    runFrames();
    expect(settled).toEqual([rail]);
  });

  // LinkedIn's shape: the feed scrolls inside a fixed box the size of the window.
  it('a tag in a fixed box wider than half the window (the feed itself) is not pinned', () => {
    const card = unit(300, 400, 800, 1200);
    tracker.watch(card);
    onScreen(card);
    runFrames();
    expect(settled).toEqual([]);
    expect(tracker.stats().railCollapsed).toBe(0);
  });

  it('only the first look counts: a feed tag seen again later is not re-checked', () => {
    const feed = unit(300);
    tracker.watch(feed);
    onScreen(feed);
    runFrames();
    onScreen(feed);
    runFrames();
    expect(settled).toEqual([]);
    expect(tracker.stats().lateInView).toBe(1);
  });
});

// Before the reader has done anything, a hide takes its real mode at once: a tag at
// load is noise on a page nobody is reading yet (Google's ad block, 2026-10-01).
describe('viewport tracker, load grace', () => {
  /** A tracker that has not seen the beforeEach's wheel. */
  function freshTracker(): LateTracker {
    tracker.disconnect();
    return (tracker = viewportTracker(win as unknown as Window & typeof globalThis)!(() => {}));
  }

  it('says "load" until the first gesture, and counts each such hide', () => {
    const t = freshTracker();
    expect(t.loadHide?.()).toBe(true);
    expect(t.loadHide?.()).toBe(true);
    expect(t.stats().hidesAtLoad).toBe(2);
    document.dispatchEvent(new Event('wheel'));
    expect(t.loadHide?.()).toBe(false);
    expect(t.stats().hidesAtLoad).toBe(2);
  });

  it("any scroll ends it, the site's own included", () => {
    const t = freshTracker();
    scroll(10, []);
    expect(t.loadHide?.()).toBe(false);
  });

  it('a key or a pointer ends it', () => {
    const t = freshTracker();
    document.dispatchEvent(new Event('keydown'));
    expect(t.loadHide?.()).toBe(false);
  });

  it('ends on its own after LOAD_GRACE_MS', () => {
    vi.useFakeTimers();
    try {
      const t = freshTracker();
      vi.advanceTimersByTime(LOAD_GRACE_MS - 1);
      expect(t.loadHide?.()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(t.loadHide?.()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The content script runs at document_start (Facebook's Stories bar was on screen
  // 2.3-2.9 s before a document_idle script ran, 2026-10-01). The clock waits for the page.
  it('started while the document is still loading, counts from DOMContentLoaded', () => {
    vi.useFakeTimers();
    const state = Object.getOwnPropertyDescriptor(document, 'readyState');
    try {
      Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
      const t = freshTracker();
      vi.advanceTimersByTime(LOAD_GRACE_MS * 2);
      expect(t.loadHide?.(), 'no clock before DOMContentLoaded').toBe(true);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      vi.advanceTimersByTime(LOAD_GRACE_MS - 1);
      expect(t.loadHide?.()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(t.loadHide?.()).toBe(false);
    } finally {
      if (state) Object.defineProperty(document, 'readyState', state);
      else delete (document as { readyState?: string }).readyState;
      vi.useRealTimers();
    }
  });
});
