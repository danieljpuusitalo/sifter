import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

// A generic (opt-in) site has no unit selector, so units are found by structure. The
// full walk stops at 6000 elements; an infinite-scroll page grows past that, and its
// newest cards must still be found from the mutation that added them.

const HOST = 'shop.example';
const card = (i: number, ad = false) =>
  `<article class="card" id="c${i}"><h2>Story ${i}</h2>${ad ? '<small>Sponsored</small>' : ''}` +
  `<p>Some body text that is long enough to count as a real unit of content, number ${i}.</p></article>`;

describe('generic collection on incremental passes', () => {
  let scanner: Scanner;
  const settle = () => vi.advanceTimersByTimeAsync(1500);
  const hidden = (id: string) => document.getElementById(id)!.classList.contains(HIDDEN_CLASS);
  const start = async () => {
    scanner = new Scanner({
      doc: document,
      hostname: HOST,
      baseUrl: `https://${HOST}/`,
      adapter: null,
      context: defaultContext(HOST),
      persistOverride: () => {},
    });
    scanner.start();
    await settle();
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    scanner.stop();
    vi.useRealTimers();
  });

  const bigPage = (cards: string) =>
    `<div id="filler">${'<i></i>'.repeat(6500)}</div><main id="feed">${cards}</main>`;

  it('hides a sponsored card appended past the 6000-element walk cap; a normal one stays a unit', async () => {
    document.body.innerHTML = bigPage([1, 2, 3, 4, 5].map((i) => card(i)).join(''));
    await start();
    const feed = document.getElementById('feed')!;
    const before = scanner.state().perf.unitsExamined;
    feed.insertAdjacentHTML('beforeend', card(6) + card(7, true));
    await settle();
    expect(scanner.state().perf.unitsExamined - before, 'positive control: the new cards were examined').toBeGreaterThanOrEqual(2);
    expect(hidden('c7')).toBe(true);
    expect(hidden('c6')).toBe(false);
  });

  it('the work of a pass scales with the change, not with the page', async () => {
    document.body.innerHTML = bigPage([1, 2, 3, 4, 5].map((i) => card(i)).join(''));
    await start();
    const feed = document.getElementById('feed')!;
    // The first five sit past the cap, so the first append examines them too; measure the second.
    feed.insertAdjacentHTML('beforeend', card(7));
    await settle();
    const before = scanner.state().perf.unitsExamined;
    feed.insertAdjacentHTML('beforeend', card(8) + card(9));
    await settle();
    const cost = scanner.state().perf.unitsExamined - before;
    expect(cost).toBeGreaterThanOrEqual(2);
    expect(cost).toBeLessThanOrEqual(4);
  });

  it('an outer wrapper that holds a known unit never becomes a unit', async () => {
    const section = (n: number, ad: boolean) =>
      `<section class="grp" id="s${n}">${[1, 2, 3, 4].map((k) => card(n * 10 + k, ad && k === 1)).join('')}</section>`;
    document.body.innerHTML = `<main id="feed">${[1, 2, 3, 4].map((n) => section(n, n === 2)).join('')}</main>`;
    await start();
    expect(hidden('c21'), 'positive control: the sponsored card is hidden on the full pass').toBe(true);
    expect(hidden('s2')).toBe(false);
    const before = scanner.state().perf.unitsExamined;
    document.getElementById('feed')!.insertAdjacentHTML('beforeend', section(5, true));
    await settle();
    // Only the four new cards: the old sections hold known units and are not examined.
    const cost = scanner.state().perf.unitsExamined - before;
    expect(cost).toBeGreaterThanOrEqual(4);
    expect(cost).toBeLessThanOrEqual(5);
    expect(hidden('c51'), 'the new sponsored card is hidden').toBe(true);
    expect(hidden('s5')).toBe(false);
    expect(hidden('s2'), 'an old wrapper holding a hidden card is not hidden whole').toBe(false);
    expect(hidden('c22')).toBe(false);
  });
});
