import { beforeEach, describe, expect, it } from 'vitest';
import { viewportTracker, type VeilTracker } from '../../src/content/viewport';

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
    scroll(250, [u]);
    runFrames();
    expect(settled).toEqual([u]);
    expect(tracker.stats().veilsUnderTop).toBe(1);
    // Its bottom went from 350 to -50 + 36: the page scrolls back by that much.
    expect(scrolls).toEqual([-364]);
  });

  // `scrollend` fires in the scroll's own frame, before that frame paints: a collapse in
  // its first animation frame would paint together with the scroll, as one visible move.
  it('waits a frame after the scroll ends before it collapses anything', () => {
    const u = unit(200);
    tracker.watch(u);
    onScreen(u);
    runFrames();
    scroll(250, [u]);
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
