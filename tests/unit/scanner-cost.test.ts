import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';

// Hard rule 7 as a deterministic check: the work a rescan does must scale with
// what changed, not with how long the feed has grown. Wall-clock is too noisy for
// CI, so this counts units examined; `pnpm bench:scroll` measures frames.

const card = (i: number, ad = false) =>
  `<div data-lazy-mount-id="m${i}"><div role="listitem" componentkey="update-card-focus${10000 + i}x">` +
  `<div><p componentkey="h${i}a"><span>${ad ? 'Acme' : `Person ${i}`}</span></p>` +
  `<p componentkey="h${i}b"><span>${ad ? 'Promoted' : 'Engineer'}</span></p></div>` +
  `<p componentkey="b${i}"><span>Post body number ${i} with enough words to be a real post.</span></p>` +
  `<span class="cnt">${i}</span> reactions</div></div>`;

describe('scanner cost scales with the change, not the page', () => {
  let scanner: Scanner;
  const examined = () => scanner.state().perf.unitsExamined;
  const settle = () => vi.advanceTimersByTimeAsync(1500);

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div data-testid="mainFeed" role="list">${Array.from({ length: 300 }, (_, i) => card(i)).join('')}</div>`;
    scanner = new Scanner({
      doc: document,
      hostname: 'www.linkedin.com',
      baseUrl: 'https://www.linkedin.com/',
      adapter: adapterFor('www.linkedin.com'),
      context: { siteKey: 'linkedin.com', enabled: true, pausedUntil: null, hideMode: 'collapse', overrides: {} },
      persistOverride: () => {},
    });
    scanner.start();
    await settle();
  });
  afterEach(() => {
    scanner.stop();
    vi.useRealTimers();
  });

  it('appending 10 cards to a 300-card feed examines about 10 units', async () => {
    const before = examined();
    const feed = document.querySelector('[data-testid="mainFeed"]') as HTMLElement;
    feed.insertAdjacentHTML('beforeend', Array.from({ length: 10 }, (_, i) => card(1000 + i, i === 3)).join(''));
    await settle();
    expect(examined() - before).toBeLessThanOrEqual(20);
    expect(document.querySelector('[componentkey="update-card-focus11003x"]')?.classList.contains(HIDDEN_CLASS)).toBe(true);
  });

  it('a counter ticking inside one card re-examines only that card', async () => {
    const before = examined();
    const cnt = document.querySelectorAll('.cnt')[150] as HTMLElement;
    cnt.textContent = '999';
    await settle();
    expect(examined() - before).toBeLessThanOrEqual(3);
  });

  it('a card whose header turns into an ad after mounting is still caught', async () => {
    const label = document.querySelector('[componentkey="h42b"] > span') as HTMLElement;
    label.textContent = 'Promoted';
    await settle();
    expect(document.querySelector('[componentkey="update-card-focus10042x"]')?.classList.contains(HIDDEN_CLASS)).toBe(true);
  });

  it('text rewritten in place (nodeValue, as React does) is seen too', async () => {
    const text = (document.querySelector('[componentkey="h77b"] > span') as HTMLElement).firstChild as Text;
    text.nodeValue = 'Promoted';
    await settle();
    expect(document.querySelector('[componentkey="update-card-focus10077x"]')?.classList.contains(HIDDEN_CLASS)).toBe(true);
  });
});
