// Which queued units are near the reader, so the decide queue takes them first.
//
// Measured on live LinkedIn (bench:live, 2026-10-01): the page keeps the main thread
// busy 400-800 ms of every second, so most slices start on their idle timeout and
// decide about one unit. A batch's units waited in document order, about 200 ms per
// place, and a post on screen could sit behind every post below it that the same
// batch collected: hides that landed on screen took up to 1 s (on screen when their
// content arrived) and 2.7 s (scrolled into view while queued). Units within a
// screen of the viewport go first; the rest keep their order behind them.
//
// An IntersectionObserver, not a rect read: no layout, and its answers arrive
// between frames, before the next idle slice runs. A unit is watched only while
// queued.

export interface NearTracker {
  watch(unit: Element): void;
  unwatch(unit: Element): void;
  isNear(unit: Element): boolean;
  /** Changes whenever a watched unit's nearness does: the queue reorders only then. */
  readonly version: number;
  disconnect(): void;
}

/** One screen above and below. */
const NEAR_MARGIN = '100% 0px';

export class NearObserver implements NearTracker {
  private readonly io: IntersectionObserver;
  private readonly near = new Set<Element>();
  version = 0;

  constructor(IO: typeof IntersectionObserver) {
    // `scrollMargin` (Chrome 120+) widens the clip of a feed that scrolls inside an
    // element (LinkedIn's <main>) the way `rootMargin` widens the window's; without
    // it, older Chrome counts only what that element shows. Unknown keys are ignored.
    this.io = new IO((entries) => this.onEntries(entries), {
      rootMargin: NEAR_MARGIN,
      scrollMargin: NEAR_MARGIN,
    } as IntersectionObserverInit);
  }

  watch(unit: Element): void {
    this.io.observe(unit);
  }

  unwatch(unit: Element): void {
    this.io.unobserve(unit);
    if (this.near.delete(unit)) this.version++;
  }

  isNear(unit: Element): boolean {
    return this.near.has(unit);
  }

  disconnect(): void {
    this.io.disconnect();
    this.near.clear();
  }

  private onEntries(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const was = this.near.has(e.target);
      if (e.isIntersecting === was) continue;
      if (e.isIntersecting) this.near.add(e.target);
      else this.near.delete(e.target);
      this.version++;
    }
  }
}

/** The page's tracker, or undefined where there is no IntersectionObserver (the queue keeps document order). */
export function nearTracker(win: Window & typeof globalThis): NearTracker | undefined {
  return typeof win.IntersectionObserver === 'function' ? new NearObserver(win.IntersectionObserver) : undefined;
}
