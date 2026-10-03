import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_GRACE_MS, viewportTracker, type VeilTracker } from '../../src/content/viewport';

// The tracker's on-screen checks, with the browser's parts faked: an
// IntersectionObserver that reports what the test says, frames run by hand, and
// units whose rects the test moves. Scrolling is a scroll event plus a new
// scrollY; a unit "moves with the page" only if the test moves its rect too.

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
let tracker: VeilTracker;
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
    return { top: r.top, bottom: r.bottom, left: 0, right: 600, width: 600, height: r.bottom - r.top, x: 0, y: r.top } as DOMRect;
  };
  return u;
}

/** The observer says `u` is on screen. */
function onScreen(u: Element): void {
  FakeIO.last.cb([{ target: u, isIntersecting: true, boundingClientRect: u.getBoundingClientRect(), rootBounds: null } as unknown as IntersectionObserverEntry]);
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
});

describe('viewport tracker, on-screen veils', () => {
  it('a veil in a sticky box that fits the window (a rail) settles at the first look', () => {
    const rail = unit(70, 400, 700);
    const feed = unit(300);
    tracker.watch(rail);
    tracker.watch(feed);
    onScreen(rail);
    onScreen(feed);
    runFrames();
    expect(settled).toEqual([rail]);
    expect(scrolls, 'a pinned collapse is not corrected with a scroll').toEqual([]);
    expect(tracker.stats().veilsPinned).toBe(1);
  });

  // A rail taller than the window (the bench's) is still a side column: waiting for a
  // scroll to prove it pinned only moves its lower modules later, out of nowhere.
  it('a veil in a sticky side column taller than the window settles at the first look too', () => {
    const rail = unit(70, 400, 2000);
    tracker.watch(rail);
    onScreen(rail);
    runFrames();
    expect(settled).toEqual([rail]);
    expect(scrolls).toEqual([]);
  });

  // Something above collapsed and a scroll undid the move (Sifter's own correction, or
  // Chrome's anchoring): the page scrolled and the feed card stayed put. It is not pinned;
  // collapsing it would move everything under it on screen.
  it('a feed card that stayed put because a scroll undid a move above it is not pinned', () => {
    const feed = unit(300);
    tracker.watch(feed);
    onScreen(feed);
    runFrames();
    scroll(-300, []);
    runFrames();
    expect(settled).toEqual([]);
    expect(tracker.stats().veilsPinned).toBe(0);
  });

  // LinkedIn's shape: the feed scrolls inside a fixed box the size of the window.
  it('a veil in a fixed box wider than half the window (the feed itself) is not pinned', () => {
    const card = unit(300, 400, 800, 1200);
    tracker.watch(card);
    onScreen(card);
    runFrames();
    expect(settled, 'not at the first look').toEqual([]);
    scroll(-300, []);
    runFrames();
    expect(settled, 'nor after a scroll that left it put').toEqual([]);
    expect(tracker.stats().veilsPinned).toBe(0);
  });

  it('a moving veil whose top went under the header settles, and the move is undone', () => {
    const u = unit(200);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(600, [u]);
    runFrames();
    expect(settled).toEqual([u]);
    expect(tracker.stats().veilsUnderTop).toBe(1);
    // Its bottom went from 0 to -400 + 36: the page scrolls back by that much.
    expect(scrolls).toEqual([-364]);
  });

  // Live report D: a tall veil just past the header still fills the screen. Collapsing
  // it there, corrected on its bottom edge, slid the post above down by ~800 px.
  it('a tall veil whose top went under the header waits until nearly all of it is gone', () => {
    const u = unit(200, 900);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(250, [u]);
    runFrames();
    expect(settled, 'top at -50, but 850 px of it still on screen').toEqual([]);
    expect(scrolls).toEqual([]);
    scroll(1000, [u]);
    runFrames();
    expect(settled).toEqual([u]);
    expect(tracker.stats().veilsUnderTop).toBe(1);
  });

  // Live report D: a jump the correction should have undone. A scroll that lands
  // leaves no miss. One the scroller swallows is counted, with its size, and left
  // alone. One that lands while the layout moves again under it is corrected once more.
  describe('a correction that misses', () => {
    /** `moves`: how far the scroller goes per call; `extra`: a layout shift on the first call only. */
    function run(moves: (dy: number) => number, extra = 0) {
      const u = unit(200);
      let first = true;
      (win as unknown as { scrollBy: (o: ScrollToOptions) => void }).scrollBy = (o) => {
        const dy = moves(o.top ?? 0);
        scrolls.push(o.top ?? 0);
        win.scrollY += dy;
        const shift = dy + (first ? extra : 0);
        first = false;
        const r = rects.get(u)!;
        rects.set(u, { top: r.top - shift, bottom: r.bottom - shift });
      };
      tracker.watch(u);
      onScreen(u);
      runFrames();
      scroll(600, [u]);
      runFrames();
    }

    it('a scroll that lands is no miss', () => {
      run((dy) => dy);
      expect(scrolls).toEqual([-364]);
      expect(tracker.stats()).toMatchObject({ anchorCorrections: 1, correctionMisses: 0, correctionRetries: 0 });
    });

    it('a clamped scroll is counted and not retried', () => {
      run(() => 0);
      expect(scrolls).toEqual([-364]);
      expect(tracker.stats()).toMatchObject({ correctionMisses: 1, maxCorrectionMissPx: 364, correctionsClamped: 1, correctionRetries: 0 });
    });

    it('a layout that moved again under a landed scroll is corrected once more', () => {
      run((dy) => dy, -100);
      // The first scroll landed, but the content came down 100 px further: one more scroll takes it back.
      expect(scrolls).toEqual([-364, 100]);
      expect(tracker.stats()).toMatchObject({ correctionMisses: 1, maxCorrectionMissPx: 100, correctionsClamped: 0, correctionRetries: 1, retryMisses: 0 });
    });
  });

  // Live report D: a "below" report can be 100+ ms old on a busy page, and the scroll
  // does not wait for it. Mid-scroll, the collapse waits for the scroll to stop and a
  // look at where the unit really is.
  describe('a unit reported below the viewport', () => {
    function below(u: Element): void {
      FakeIO.last.cb([{ target: u, isIntersecting: false, boundingClientRect: u.getBoundingClientRect(), rootBounds: { top: 0, bottom: 800 } } as unknown as IntersectionObserverEntry]);
    }

    it('collapses at the next still frame when nothing is scrolling', () => {
      const u = unit(1000);
      tracker.watch(u);
      below(u);
      expect(settled, 'not from the report itself').toEqual([]);
      runFrames();
      expect(settled).toEqual([u]);
      expect(tracker.stats()).toMatchObject({ belowDeferred: 1, belowCameInView: 0 });
    });

    // 2026-10-01, 881 px: a long site task held every scroll event back, so the page
    // looked still while the compositor scrolled the unit onto the screen.
    it('with no scroll event at all, stays veiled if a fresh look finds it on screen', () => {
      const u = unit(1000);
      tracker.watch(u);
      below(u);
      // The compositor's scroll, which the main thread only learns of at its next frame.
      win.scrollY += 500;
      rects.set(u, { top: 500, bottom: 900 });
      runFrames();
      expect(settled).toEqual([]);
      expect(tracker.stats()).toMatchObject({ belowDeferred: 1, belowCameInView: 1 });
    });

    it('mid-scroll, collapses once the scroll stops if it is still below', () => {
      const u = unit(1000);
      tracker.watch(u);
      document.dispatchEvent(new Event('scroll'));
      below(u);
      expect(settled, 'not while the page is moving').toEqual([]);
      document.dispatchEvent(new Event('scrollend'));
      runFrames();
      expect(settled).toEqual([u]);
      expect(tracker.stats()).toMatchObject({ belowDeferred: 1, belowCameInView: 0 });
    });

    it('mid-scroll, stays veiled if it reached the screen meanwhile', () => {
      const u = unit(1000);
      tracker.watch(u);
      document.dispatchEvent(new Event('scroll'));
      below(u);
      // The scroll the report did not know about: the unit is now on screen.
      scroll(500, [u]);
      runFrames();
      expect(settled).toEqual([]);
      expect(tracker.stats()).toMatchObject({ belowDeferred: 1, belowCameInView: 1 });
    });
  });

  // `scrollend` fires in the scroll's own frame, before that frame paints: a collapse in
  // its first animation frame would paint together with the scroll, as one visible move.
  it('waits a frame after the scroll ends before it collapses anything', () => {
    const u = unit(200);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(600, [u]);
    frames.shift()!();
    expect(settled, 'nothing in the frame the scroll ended in').toEqual([]);
    runFrames();
    expect(settled).toEqual([u]);
  });

  it('a moving veil with its top still clear of the header stays veiled', () => {
    const u = unit(400);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(200, [u]);
    runFrames();
    expect(settled).toEqual([]);
  });

  it('a veil never seen moving is not collapsed from under the header (it may be pinned there)', () => {
    const u = unit(10);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(20, []);
    runFrames();
    expect(settled).toEqual([]);
    expect(scrolls).toEqual([]);
  });
});

// Before the reader has done anything, a hide takes its real mode at once: a veil
// at load only strands the page below a blank band (Google's ad block, 2026-10-01).
describe('viewport tracker, load grace', () => {
  it('says "load" until the first gesture, and counts each such hide', () => {
    expect(tracker.loadHide?.()).toBe(true);
    expect(tracker.loadHide?.()).toBe(true);
    expect(tracker.stats().hidesAtLoad).toBe(2);
    document.dispatchEvent(new Event('wheel'));
    expect(tracker.loadHide?.()).toBe(false);
    expect(tracker.stats().hidesAtLoad).toBe(2);
  });

  it('any scroll ends it, the site\'s own included', () => {
    scroll(10, []);
    expect(tracker.loadHide?.()).toBe(false);
  });

  it('a key or a pointer ends it', () => {
    document.dispatchEvent(new Event('keydown'));
    expect(tracker.loadHide?.()).toBe(false);
  });

  it('ends on its own after LOAD_GRACE_MS', () => {
    vi.useFakeTimers();
    try {
      tracker.disconnect();
      tracker = viewportTracker(win as unknown as Window & typeof globalThis)!(() => {});
      vi.advanceTimersByTime(LOAD_GRACE_MS - 1);
      expect(tracker.loadHide?.()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(tracker.loadHide?.()).toBe(false);
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
      tracker.disconnect();
      tracker = viewportTracker(win as unknown as Window & typeof globalThis)!(() => {});
      vi.advanceTimersByTime(LOAD_GRACE_MS * 2);
      expect(tracker.loadHide?.(), 'no clock before DOMContentLoaded').toBe(true);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      vi.advanceTimersByTime(LOAD_GRACE_MS - 1);
      expect(tracker.loadHide?.()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(tracker.loadHide?.()).toBe(false);
    } finally {
      if (state) Object.defineProperty(document, 'readyState', state);
      else delete (document as { readyState?: string }).readyState;
      vi.useRealTimers();
    }
  });
});
