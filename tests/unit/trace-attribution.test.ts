import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { COLLAPSE_CLASS, HIDDEN_CLASS, TAG_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { heightState, MAX_EVENTS, Tracer } from '../../src/content/trace';
import { EMPTY_LATE_STATS, type LateTracker } from '../../src/content/viewport';
import { defaultContext } from '../../src/messages';

// Scroll-stability Phase 0: the trace attributes every height change Sifter makes, every
// scroll correction, and every re-mount. These tests pin what each counter means, each
// with a positive control so a counter stuck at zero cannot pass.

/** Every IntersectionObserver the tracer builds, answered by hand. The first one is the write-zone observer. */
class FakeIO {
  static all: FakeIO[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly cb: (entries: IntersectionObserverEntry[]) => void) {
    FakeIO.all.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {}
  /** One callback for everything observed: in view, or a box above or below a 0-800 band. */
  answer(zone: (el: Element) => 'in' | 'above' | 'below'): void {
    const entries = [...this.observed].map((target) => {
      const z = zone(target);
      const top = z === 'above' ? -500 : z === 'below' ? 1500 : 100;
      return {
        target,
        isIntersecting: z === 'in',
        boundingClientRect: { top, bottom: top + 300, width: 500, height: 300 },
        rootBounds: { top: 0, bottom: 800 },
      } as unknown as IntersectionObserverEntry;
    });
    if (entries.length) this.cb(entries);
  }
}

const writeIO = () => FakeIO.all[0] as FakeIO;

function tracer(frames?: Array<() => void>) {
  FakeIO.all = [];
  return new Tracer(FakeIO as unknown as typeof IntersectionObserver, frames ? { frame: (fn) => void frames.push(fn) } : {});
}

function unit(key: string | null = 'k1'): HTMLElement {
  const u = document.createElement('div');
  if (key) u.setAttribute('componentkey', key);
  return document.body.appendChild(u);
}

const collapse = (u: Element) => u.classList.add(HIDDEN_CLASS, COLLAPSE_CLASS);
const tag = (u: Element) => u.classList.add(TAG_CLASS);
const release = (u: Element) => u.classList.remove(HIDDEN_CLASS, COLLAPSE_CLASS, TAG_CLASS);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('heightState', () => {
  it('reads collapsed from the hide classes or display:none, and a tag as full', () => {
    const u = unit();
    expect(heightState(u)).toBe('full');
    collapse(u);
    expect(heightState(u)).toBe('collapsed');
    release(u);
    tag(u);
    expect(heightState(u), 'a tag keeps its height').toBe('full');
    const h = unit();
    h.classList.add(HIDDEN_CLASS);
    expect(heightState(h), 'blur mode: hidden but full height').toBe('full');
    h.style.display = 'none';
    expect(heightState(h), 'hide mode').toBe('collapsed');
  });
});

describe('Tracer: height writes', () => {
  it('counts a write that changed the height by path and zone a frame later, and a tag as neutral', () => {
    const t = tracer();
    const a = unit('a');
    const b = unit('b');
    collapse(a);
    t.wrote(a, 'lane', 10);
    tag(b);
    t.wrote(b, 'decide', 11);
    expect(writeIO().observed.has(a), 'positive control: the height write waits for its zone').toBe(true);
    expect(writeIO().observed.has(b), 'a neutral write is not watched').toBe(false);
    writeIO().answer(() => 'above');
    const s = t.stats().attribution;
    expect(s.heightWrites.lane).toEqual({ in: 0, above: 1, below: 0, gone: 0 });
    expect(s.neutralWrites.decide).toBe(1);
    expect(s.events).toEqual([{ at: 10, kind: 'write', path: 'lane', collapsed: true }]);
    expect(writeIO().observed.size, 'answered once, then let go').toBe(0);
  });

  it('a release after a collapse is a second height write; a repeat write is neutral', () => {
    const t = tracer();
    const a = unit();
    collapse(a);
    t.wrote(a, 'lane', 1);
    writeIO().answer(() => 'below');
    t.wrote(a, 'decide', 2);
    release(a);
    t.wrote(a, 'release', 3);
    writeIO().answer(() => 'in');
    const s = t.stats().attribution;
    expect(s.heightWrites.lane.below).toBe(1);
    expect(s.neutralWrites.decide, 'still collapsed: no height change').toBe(1);
    expect(s.heightWrites.release.in).toBe(1);
  });

  it('a written unit that leaves the page before its zone counts as gone at the sweep', () => {
    const t = tracer();
    const a = unit();
    collapse(a);
    t.wrote(a, 'farBelow', 1);
    a.remove();
    t.sweep(2);
    expect(t.stats().attribution.heightWrites.farBelow.gone).toBe(1);
    expect(writeIO().observed.has(a)).toBe(false);
  });
});

describe('Tracer: re-mounts', () => {
  it('a new element with a known key is a re-mount; its height a frame later against the key is a flip', () => {
    const frames: Array<() => void> = [];
    const t = tracer(frames);
    const first = unit('post-1');
    t.born(first);
    tag(first);
    t.wrote(first, 'decide', 1);
    for (const f of frames.splice(0)) f();
    first.remove();
    const again = unit('post-1');
    t.born(again);
    collapse(again);
    t.wrote(again, 'lane', 2);
    let s = t.stats().attribution;
    expect(s.remounts, 'positive control: the second element is a re-mount').toBe(1);
    expect(s.remountFlips.toCollapsed, 'not before the frame').toBe(0);
    for (const f of frames.splice(0)) f();
    s = t.stats().attribution;
    expect(s.remountFlips).toEqual({ toCollapsed: 1, toFull: 0 });
  });

  it('the lane writing the element before born() sees it is not a re-mount', () => {
    const t = tracer();
    const u = unit('post-2');
    collapse(u);
    t.wrote(u, 'lane', 1);
    t.born(u);
    expect(t.stats().attribution.remounts).toBe(0);
    expect(t.stats().attribution.remountFlips).toEqual({ toCollapsed: 0, toFull: 0 });
  });

  it('a re-mount at the same height is not a flip; the same element again is reattached; no key is unkeyed', () => {
    const t = tracer();
    const a = unit('post-3');
    t.born(a);
    a.remove();
    const b = unit('post-3');
    t.born(b);
    t.born(b);
    t.born(unit(null));
    const s = t.stats().attribution;
    expect(s.remounts).toBe(1);
    expect(s.remountFlips).toEqual({ toCollapsed: 0, toFull: 0 });
    expect(s.reattached).toBe(1);
    expect(s.unkeyed).toBe(1);
  });

  it('keeps the key memory across a reset', () => {
    const t = tracer();
    const a = unit('post-4');
    t.born(a);
    t.reset();
    a.remove();
    t.born(unit('post-4'));
    expect(t.stats().attribution.remounts).toBe(1);
  });
});

describe('Tracer: scrolls, vanished classes, cost', () => {
  it('a correction within 150 ms of a scroll event is mid-scroll', () => {
    let clock = 0;
    FakeIO.all = [];
    const t = new Tracer(FakeIO as unknown as typeof IntersectionObserver, { doc: document, now: () => clock });
    t.scrolled(-40, 50);
    clock = 100;
    document.dispatchEvent(new Event('scroll'));
    t.scrolled(30, 200);
    const s = t.stats().attribution;
    expect(s.scrolls).toEqual({ n: 2, px: 70, whileScrolling: 1 });
    expect(s.events.filter((e) => e.kind === 'scroll')).toEqual([
      { at: 50, kind: 'scroll', delta: -40, whileScrolling: false },
      { at: 200, kind: 'scroll', delta: 30, whileScrolling: true },
    ]);
  });

  it('counts a tracked hide whose classes the site wiped, once', () => {
    const t = tracer();
    const kept = unit('a');
    collapse(kept);
    const tagged = unit('b');
    tag(tagged);
    const wiped = unit('c');
    t.classesKept([kept, tagged, wiped]);
    t.classesKept([kept, tagged, wiped]);
    expect(t.stats().attribution.classesVanished).toBe(1);
  });

  it('summarises cost samples', () => {
    const t = tracer();
    t.cost('flush', 1);
    t.cost('flush', 3);
    expect(t.stats().attribution.cost.flush).toEqual({ n: 2, totalMs: 4, p99: 3, max: 3 });
    expect(t.stats().attribution.cost.io.n).toBe(0);
  });

  it('caps the event log', () => {
    const t = tracer();
    for (let i = 0; i < MAX_EVENTS + 5; i++) t.scrolled(1, i);
    const s = t.stats().attribution;
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect(s.eventCount).toBe(MAX_EVENTS + 5);
  });
});

describe('Scanner with an attributing trace', () => {
  const html = readFileSync(join('fixtures', 'public', 'linkedin-feed.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  let scanner: Scanner | undefined;
  afterEach(() => {
    scanner?.stop();
    scanner = undefined;
  });

  /** A tracker that tags every late hide and never settles one (the reader is looking at everything). */
  const tagEverything = (): LateTracker => ({ watch() {}, unwatch() {}, stats: () => ({ ...EMPTY_LATE_STATS }), disconnect() {} });

  it('a post first seen as a tag and re-mounted is collapsed by the lane: a re-mount flip to collapsed', async () => {
    document.head.innerHTML = `<style>${style}</style>`;
    document.body.innerHTML = body;
    const frames: Array<() => void> = [];
    const trace = tracer(frames);
    scanner = new Scanner({
      doc: document,
      hostname: 'www.linkedin.com',
      baseUrl: 'https://www.linkedin.com/feed/',
      adapter: adapterFor('www.linkedin.com'),
      context: defaultContext('linkedin.com'),
      persistOverride: () => {},
      schedule: (fn) => fn(),
      frame: (fn) => void frames.push(fn),
      now: () => 0,
      viewport: () => tagEverything(),
      trace,
    });
    scanner.start();
    const ad = document.querySelector('[componentkey^="update-card-focus1002"]') as HTMLElement;
    expect(ad.classList.contains(TAG_CLASS), 'positive control: the ad is a tag at full height').toBe(true);
    expect(trace.stats().attribution.neutralWrites.decide).toBeGreaterThan(0);
    // The site unmounts the post and re-creates it whole, as a virtualised feed does.
    const wrapper = ad.parentElement as HTMLElement;
    const copy = ad.cloneNode(true) as HTMLElement;
    copy.classList.remove(TAG_CLASS);
    copy.querySelector('[data-sifter-placeholder]')?.remove();
    ad.remove();
    await Promise.resolve();
    wrapper.appendChild(copy);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(copy.classList.contains(HIDDEN_CLASS), 'positive control: the lane hid the re-mount').toBe(true);
    for (const f of frames.splice(0)) f();
    const s = trace.stats().attribution;
    expect(s.remounts).toBe(1);
    expect(s.remountFlips.toCollapsed).toBe(1);
    expect(s.heightWrites.lane.in + s.heightWrites.lane.above + s.heightWrites.lane.below + s.heightWrites.lane.gone + (writeIO().observed.has(copy) ? 1 : 0)).toBe(1);
  });
});
