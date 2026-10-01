import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { NearObserver } from '../../src/content/near';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

/** An IntersectionObserver the test answers by hand. */
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
  disconnect(): void {
    this.observed.clear();
  }
  answer(near: (el: Element) => boolean): void {
    const entries = [...this.observed].map((target) => ({ target, isIntersecting: near(target) }) as unknown as IntersectionObserverEntry);
    if (entries.length) this.cb(entries);
  }
}

const near = () => new NearObserver(FakeIO as unknown as typeof IntersectionObserver);

describe('NearObserver', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('tracks nearness and bumps its version only on a change', () => {
    const n = near();
    const a = document.body.appendChild(document.createElement('div'));
    const b = document.body.appendChild(document.createElement('div'));
    n.watch(a);
    n.watch(b);
    FakeIO.last.answer((el) => el === a);
    expect([n.isNear(a), n.isNear(b)]).toEqual([true, false]);
    const v = n.version;
    FakeIO.last.answer((el) => el === a);
    expect(n.version).toBe(v);
    n.unwatch(a);
    expect(n.isNear(a)).toBe(false);
    expect(n.version).toBe(v + 1);
    expect(FakeIO.last.observed.has(a)).toBe(false);
  });
});

describe('Scanner queue order', () => {
  const html = readFileSync(join('fixtures', 'public', 'linkedin-feed.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const byKey = (k: string) => document.querySelector(`[componentkey^="update-card-focus${k}"]`) as HTMLElement;

  /**
   * Slices run one at a time from a task list, and the clock moves 5 ms per read,
   * so every slice is over budget after its first unit: one decision per slice, as
   * on a busy live page.
   */
  function setup(withNear: boolean) {
    // The fixture's styles hide its decoy spans: without them, a hidden "Promoted" reads as shown.
    document.head.innerHTML = `<style>${style}</style>`;
    document.body.innerHTML = body;
    const tasks: (() => void)[] = [];
    let t = 0;
    const tracker = withNear ? near() : undefined;
    const scanner = new Scanner({
      doc: document,
      hostname: 'www.linkedin.com',
      baseUrl: 'https://www.linkedin.com/',
      adapter: adapterFor('www.linkedin.com'),
      context: defaultContext('linkedin.com'),
      persistOverride: () => {},
      schedule: (fn) => tasks.push(fn),
      now: () => (t += 5),
      near: tracker,
    });
    scanner.scanNow();
    const step = () => (tasks.shift() as () => void)();
    return { scanner, step, tasks };
  }

  it('decides a unit near the viewport before the ones above it in the document', () => {
    const { step } = setup(true);
    step(); // collects every unit; the slice is then out of budget
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    // Between frames: only 1006, the third ad down, is near the reader.
    FakeIO.last.answer((el) => el === byKey('1006'));
    step();
    expect(byKey('1006').classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    // A decided unit is no longer watched.
    expect(FakeIO.last.observed.has(byKey('1006'))).toBe(false);
  });

  it('without a tracker the queue keeps document order (the control)', () => {
    const { step } = setup(false);
    step();
    step();
    step();
    // 1001 then 1002 decided: the first ad is hidden, the third is still waiting.
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(byKey('1006').classList.contains(HIDDEN_CLASS)).toBe(false);
  });

  it('still hides everything, near or not, once the queue drains', () => {
    const { step, tasks } = setup(true);
    step();
    FakeIO.last.answer((el) => el === byKey('1006'));
    for (let n = 0; tasks.length && n < 100; n++) step();
    for (const k of ['1002', '1004', '1006']) expect(byKey(k).classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(FakeIO.last.observed.size).toBe(0);
  });
});
