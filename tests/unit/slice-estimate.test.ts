import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

// The slice's stopping estimate (a moving average of one decision's cost) against
// a single outlier. On live LinkedIn a GC can land inside one decision (a 25 ms
// MajorGC, 2026-10-04): that says nothing about the next unit. The clock here only
// moves inside detectMarker, by a scripted cost per decision, so slice counts are exact.

const clock = vi.hoisted(() => ({ t: 0, costs: [] as number[], steady: 0.3 }));

vi.mock('../../src/extract', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/extract')>();
  return {
    ...m,
    detectMarker: (...args: Parameters<typeof m.detectMarker>) => {
      clock.t += clock.costs.shift() ?? clock.steady;
      return m.detectMarker(...args);
    },
  };
});

const card = (i: number, ad = false) =>
  `<div role="listitem" componentkey="update-card-focus${10000 + i}x">` +
  `<div><p componentkey="h${i}a"><span>${ad ? 'Acme' : `Person ${i}`}</span></p>` +
  `<p componentkey="h${i}b"><span>${ad ? 'Promoted' : 'Engineer'}</span></p></div>` +
  `<p componentkey="b${i}"><span>Post body number ${i} with enough words to be a real post.</span></p></div>`;

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.stop();
  scanner = undefined;
});

/** A 40-card feed decided from cold: returns the slices it took and how many units were decided. */
function run(costs: number[], steady: number) {
  clock.t = 0;
  clock.costs = [...costs];
  clock.steady = steady;
  document.body.innerHTML = `<main><div data-testid="mainFeed" role="list">${Array.from({ length: 40 }, (_, i) => card(i, i === 39)).join('')}</div></main>`;
  const queue: Array<() => void> = [];
  scanner = new Scanner({
    doc: document,
    hostname: 'www.linkedin.com',
    baseUrl: 'https://www.linkedin.com/feed/',
    adapter: adapterFor('www.linkedin.com'),
    context: defaultContext('linkedin.com'),
    persistOverride: () => {},
    schedule: (fn) => void queue.push(fn),
    frame: () => {},
    now: () => clock.t,
  });
  scanner.start();
  for (let i = 0; queue.length && i < 1000; i++) queue.shift()!();
  const perf = scanner.state().perf;
  return { slices: perf.slices, decided: perf.unitsDecided, adHidden: !!document.querySelector('[componentkey="update-card-focus10039x"]')?.classList.contains(HIDDEN_CLASS) };
}

describe('the decide-cost estimate', () => {
  it('one 30 ms decision does not hold the next slices to one unit each', () => {
    const base = run([], 0.3);
    const spike = run([30], 0.3);
    // Positive control: every unit was decided and the ad at the end still hidden.
    expect(base.decided).toBe(40);
    expect(spike.decided).toBe(40);
    expect(spike.adHidden).toBe(true);
    // One outlier costs at most one extra slice over the same feed without it
    // (2026-10-04: 4 slices without the spike; with it, 6 unclamped, 4 clamped).
    expect(spike.slices - base.slices).toBeLessThanOrEqual(1);
  });

  it('positive control: a steady cost past the budget still decides one unit per slice', () => {
    const slow = run([], 5);
    expect(slow.decided).toBe(40);
    expect(slow.slices).toBeGreaterThanOrEqual(40);
  });
});
