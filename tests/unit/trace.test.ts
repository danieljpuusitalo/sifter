import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS, PLACEHOLDER_ATTR } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { MAX_FLIPS, Tracer } from '../../src/content/trace';
import { defaultContext, type SiteContext } from '../../src/messages';

/** An IntersectionObserver the test answers by hand: `answer` delivers one callback for everything observed. */
class FakeIO {
  static last: FakeIO;
  readonly observed = new Set<Element>();
  constructor(private readonly cb: (entries: IntersectionObserverEntry[]) => void) {
    FakeIO.last = this;
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {}
  answer(inView: (el: Element) => boolean): void {
    const entries = [...this.observed].map((target) => ({ target, isIntersecting: inView(target) }) as unknown as IntersectionObserverEntry);
    if (entries.length) this.cb(entries);
  }
}

const tracer = () => new Tracer(FakeIO as unknown as typeof IntersectionObserver);
const el = () => document.body.appendChild(document.createElement('div'));

describe('Tracer: hide latency', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('a unit queued off screen and hidden on screen entered while queued', () => {
    const t = tracer();
    const u = el();
    t.dirty(100);
    t.queued(u, t.takeDirty(400));
    FakeIO.last.answer(() => false);
    t.hid(u, 900, { category: 'sponsored' });
    FakeIO.last.answer(() => true);
    expect(t.stats().latency).toMatchObject({
      enteredWhileQueued: { n: 1, max: 800 },
      alreadyOnScreen: { n: 0 },
      offScreen: { n: 0 },
    });
  });

  it('a unit on screen when queued and when hidden was already on screen', () => {
    const t = tracer();
    const u = el();
    t.queued(u, 0);
    FakeIO.last.answer(() => true);
    t.hid(u, 300, { category: 'sponsored' });
    FakeIO.last.answer(() => true);
    expect(t.stats().latency.alreadyOnScreen).toMatchObject({ n: 1, p50: 300 });
  });

  it('a unit hidden in the slice that queued it takes one answer for both', () => {
    const t = tracer();
    const u = el();
    t.queued(u, 0);
    t.hid(u, 50, { category: 'sponsored' });
    FakeIO.last.answer(() => false);
    expect(t.stats().latency.offScreen).toMatchObject({ n: 1, max: 50 });
  });

  it('a queued unit is not watched once it has its answer, until it is hidden', () => {
    const t = tracer();
    const u = el();
    t.queued(u, 0);
    FakeIO.last.answer(() => false);
    expect(FakeIO.last.observed.has(u)).toBe(false);
    t.hid(u, 10, { category: 'sponsored' });
    expect(FakeIO.last.observed.has(u)).toBe(true);
    FakeIO.last.answer(() => false);
    expect(FakeIO.last.observed.has(u)).toBe(false);
  });

  it('the batch that last queued a unit counts: an earlier "no hide" was the site, not the scanner', () => {
    const t = tracer();
    const u = el();
    t.queued(u, 0);
    FakeIO.last.answer(() => false);
    t.queued(u, 1000);
    FakeIO.last.answer(() => true);
    t.hid(u, 1200, { category: 'suggested' });
    FakeIO.last.answer(() => true);
    expect(t.stats().latency.alreadyOnScreen).toMatchObject({ n: 1, max: 200 });
  });

  it('splits an on-screen hide at the collect, and counts a unit queued before', () => {
    const t = tracer();
    const u = el();
    const off = el();
    t.queued(u, 0, 100, 3);
    FakeIO.last.answer(() => false);
    t.queued(u, 1000, 1300, 7);
    t.queued(off, 1000, 1300, 8);
    FakeIO.last.answer(() => false);
    t.hid(u, 2000, { category: 'suggested' });
    t.hid(off, 2000, { category: 'suggested' });
    FakeIO.last.answer((e) => e === u);
    expect(t.stats().onScreen).toMatchObject({
      n: 1,
      requeued: 1,
      waitMs: { max: 300 },
      queueMs: { max: 700 },
      sinceFirstMs: { max: 2000 },
      depth: { max: 7 },
    });
  });

  it('splits the wait before the collect at the debounce firing', () => {
    const t = tracer();
    const u = el();
    t.dirty(100);
    t.due(360);
    t.queued(u, t.takeDirty(500), 500, 0);
    FakeIO.last.answer(() => true);
    t.hid(u, 520, { category: 'sponsored' });
    FakeIO.last.answer(() => true);
    expect(t.stats().onScreen).toMatchObject({ waitMs: { max: 400 }, debounceMs: { max: 260 }, idleMs: { max: 140 } });
  });

  it('an empty unit leaves the queue record: its content had not arrived', () => {
    const t = tracer();
    const u = el();
    t.queued(u, 0);
    t.empty(u);
    t.hid(u, 500, { category: 'sponsored' });
    FakeIO.last.answer(() => true);
    expect(t.stats().latency.alreadyOnScreen.n + t.stats().latency.enteredWhileQueued.n + t.stats().latency.offScreen.n).toBe(0);
  });
});

describe('Tracer: arrival class', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** Queue, hide and place one unit; `before` runs first (the lane's and the empty pass's hooks). */
  function hideOne(t: Tracer, inView: boolean, before: (u: Element) => void = () => {}, times = 1): Element {
    const u = el();
    before(u);
    for (let i = 0; i < times; i++) {
      t.queued(u, i * 1000);
      FakeIO.last.answer(() => false);
    }
    t.hid(u, times * 1000, { category: 'sponsored' });
    FakeIO.last.answer(() => inView);
    return u;
  }

  it('sorts each debounced hide by how its unit arrived, split by where it was at the hide', () => {
    const t = tracer();
    hideOne(t, true, (u) => t.bornBare(u));
    hideOne(t, false, (u) => t.empty(u));
    hideOne(t, true, (u) => t.laneSkipped(u, 'overflow'));
    hideOne(t, true, (u) => t.laneSkipped(u, 'abstain'));
    hideOne(t, true, undefined, 2);
    hideOne(t, false);
    expect(t.stats().arrival).toEqual({
      filled: { onScreen: 1, offScreen: 1 },
      overflow: { onScreen: 1, offScreen: 0 },
      abstain: { onScreen: 1, offScreen: 0 },
      labelLate: { onScreen: 1, offScreen: 0 },
      slow: { onScreen: 0, offScreen: 1 },
    });
  });

  it('a lane hide is not counted: it never queued', () => {
    const t = tracer();
    const u = el();
    t.hid(u, 0, { category: 'sponsored' });
    FakeIO.last.answer(() => true);
    expect(Object.values(t.stats().arrival).every((c) => c.onScreen + c.offScreen === 0)).toBe(true);
  });

  it('reset starts the counts over', () => {
    const t = tracer();
    hideOne(t, true);
    t.reset();
    expect(t.stats().arrival.slow).toEqual({ onScreen: 0, offScreen: 0 });
  });
});

describe('Tracer: flips', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('records a release with the rule and how long the hide held', () => {
    const t = tracer();
    const u = el();
    t.hid(u, 1000, { category: 'suggested', rule: 'follow', kind: 'structural', detail: 'button.follow' });
    t.released(u, 1600, 'redecided', false);
    expect(t.stats()).toMatchObject({
      flipCount: 1,
      flips: [{ what: 'redecided', userShown: false, heldMs: 600, category: 'suggested', rule: 'follow', detail: 'button.follow' }],
    });
  });

  it('a shown post that leaves the page is a "replaced" flip; a hidden one only counts', () => {
    const t = tracer();
    const shown = el();
    const hidden = el();
    t.hid(shown, 0, { category: 'suggested', rule: 'activity' });
    t.hid(hidden, 0, { category: 'sponsored' });
    t.shown(shown);
    shown.remove();
    hidden.remove();
    t.sweep(200);
    expect(t.stats()).toMatchObject({ flipCount: 1, hiddenLeft: 1, flips: [{ what: 'replaced', userShown: true, rule: 'activity' }] });
  });

  it('keeps only the newest flips', () => {
    const t = tracer();
    for (let i = 0; i < MAX_FLIPS + 5; i++) {
      const u = el();
      t.hid(u, i, { category: 'sponsored' });
      t.released(u, i + 1, 'emptied', false);
    }
    const s = t.stats();
    expect(s.flipCount).toBe(MAX_FLIPS + 5);
    expect(s.flips).toHaveLength(MAX_FLIPS);
    expect(s.flips[0]!.at).toBe(6);
  });
});

describe('Scanner with a trace', () => {
  const html = readFileSync(join('fixtures', 'public', 'linkedin-feed.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const ctx = (over: Partial<SiteContext> = {}): SiteContext => defaultContext('linkedin.com', over);

  function setup() {
    document.head.innerHTML = `<style>${style}</style>`;
    document.body.innerHTML = body;
    const trace = tracer();
    const scanner = new Scanner({
      doc: document,
      hostname: 'www.linkedin.com',
      baseUrl: 'https://www.linkedin.com/',
      adapter: adapterFor('www.linkedin.com'),
      context: ctx(),
      persistOverride: () => {},
      schedule: (fn) => fn(),
      trace,
    });
    scanner.scanNow();
    const byKey = (k: string) => document.querySelector(`[componentkey^="update-card-focus${k}"]`) as HTMLElement;
    return { scanner, trace, byKey };
  }

  it('times every hide, and reports the trace in the page state', () => {
    const { scanner, byKey } = setup();
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(true);
    FakeIO.last.answer(() => false);
    const lat = scanner.state().trace?.latency;
    expect(lat?.offScreen.n).toBe(scanner.state().hiddenNow);
  });

  it('a label that goes away releases the hide as a flip, without the label text', () => {
    const { scanner, byKey } = setup();
    const unit = byKey('1002');
    expect(unit.classList.contains(HIDDEN_CLASS)).toBe(true);
    const label = [...unit.querySelectorAll('span')].find((s) => s.textContent === 'Promoted') as HTMLElement;
    label.textContent = 'Northwind Cloud · 2h';
    scanner.scanNow();
    expect(unit.classList.contains(HIDDEN_CLASS)).toBe(false);
    const flips = scanner.state().trace?.flips ?? [];
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ what: 'redecided', userShown: false, category: 'sponsored', kind: 'label' });
    // A label marker's detail is the site's own text: never kept.
    expect(flips[0]!.detail).toBeUndefined();
    expect(JSON.stringify(scanner.state().trace)).not.toContain('Promoted');
  });

  it('a switch the user turned off is not a flip', () => {
    const { scanner, byKey } = setup();
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(true);
    scanner.applyContext(ctx({ categories: { ...ctx().categories, sponsored: false } }));
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(scanner.state().trace?.flipCount).toBe(0);
  });

  it('a shown post the site swaps out is a "replaced" flip', () => {
    const { scanner, byKey } = setup();
    const unit = byKey('1002');
    const host = unit.firstElementChild as HTMLElement;
    expect(host.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
    const show = host.shadowRoot?.querySelector('[data-act="show"]') as HTMLElement;
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isTrusted', { value: true });
    show.dispatchEvent(e);
    expect(unit.classList.contains(HIDDEN_CLASS)).toBe(false);
    unit.replaceWith(document.createElement('div'));
    scanner.scanNow();
    expect(scanner.state().trace?.flips).toMatchObject([{ what: 'replaced', userShown: true, category: 'sponsored' }]);
  });
});
