import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

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
      context: defaultContext('linkedin.com'),
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

  it('a counter tick does not re-decide the card (the change signal ignores digit runs)', async () => {
    const decided = () => scanner.state().perf.unitsDecided;
    const before = decided();
    const cnt = document.querySelectorAll('.cnt')[150] as HTMLElement;
    cnt.textContent = '1,234';
    await settle();
    expect(decided()).toBe(before);
    // Positive control: a change in the words is a real change and is decided.
    const label = document.querySelector('[componentkey="h150b"] > span') as HTMLElement;
    label.textContent = 'Promoted';
    await settle();
    expect(decided()).toBe(before + 1);
    expect(document.querySelector('[componentkey="update-card-focus10150x"]')?.classList.contains(HIDDEN_CLASS)).toBe(true);
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

  it('the debounce timer task does no DOM work: collection runs inside the idle slice', async () => {
    const before = scanner.state().perf;
    const feed = document.querySelector('[data-testid="mainFeed"]') as HTMLElement;
    feed.insertAdjacentHTML('beforeend', card(2000, true));
    await settle();
    const after = scanner.state().perf;
    expect(after.slices).toBeGreaterThan(before.slices);
    expect(after.collectMs).toBeGreaterThanOrEqual(before.collectMs);
    expect(document.querySelector('[componentkey="update-card-focus12000x"]')?.classList.contains(HIDDEN_CLASS)).toBe(true);
  });
});

describe('block rules with :has() never run against feed posts', () => {
  const post = (i: number) =>
    `<div aria-posinset="${i}"><div><h3><span>Person ${i}</span></h3><a href="/person${i}">Person ${i}</a></div>` +
    `<div><span>Post body number ${i} with enough words to be a real post.</span></div><span class="cnt">${i}</span></div>`;
  const rail =
    '<div role="complementary"><div id="rail">' +
    '<div id="ads"><div><h3><span>Sponsored</span></h3></div><div><a aria-label="Advertiser" href="https://l.facebook.com/l.php?u=x">Acme</a></div></div>' +
    '<div id="contacts"><h3>Contacts</h3><a href="/someone">Someone</a></div>' +
    '</div></div>';

  let scanner: Scanner;
  const settle = () => vi.advanceTimersByTimeAsync(1500);

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div role="feed">${Array.from({ length: 200 }, (_, i) => post(i)).join('')}</div>${rail}`;
    scanner = new Scanner({
      doc: document,
      hostname: 'www.facebook.com',
      baseUrl: 'https://www.facebook.com/',
      adapter: adapterFor('www.facebook.com'),
      context: defaultContext('facebook.com'),
      persistOverride: () => {},
    });
    scanner.start();
    await settle();
  });
  afterEach(() => {
    scanner.stop();
    vi.useRealTimers();
  });

  it('positive control: the anchored rail module is hidden, its siblings are not', () => {
    expect(document.querySelector('#ads')?.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(document.querySelector('#contacts')?.classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(document.querySelector('#rail')?.classList.contains(HIDDEN_CLASS)).toBe(false);
  });

  it('a counter tick in a post evaluates no :has() selector anywhere', async () => {
    const hasCalls: string[] = [];
    const record = (sel: string) => {
      if (sel.includes(':has(')) hasCalls.push(sel);
    };
    // Wrap every selector entry point and count the :has() selectors that reach them.
    const wrap = <K extends 'closest' | 'matches' | 'querySelectorAll' | 'querySelector'>(name: K) => {
      const orig = Element.prototype[name] as (this: Element, sel: string) => unknown;
      return vi.spyOn(Element.prototype, name).mockImplementation(function (this: Element, sel: string) {
        record(sel);
        return orig.call(this, sel);
      } as never);
    };
    const wrapped = [wrap('closest'), wrap('matches'), wrap('querySelectorAll'), wrap('querySelector')];
    try {
      const cnt = document.querySelectorAll('.cnt')[120] as HTMLElement;
      cnt.textContent = '999';
      await settle();
    } finally {
      for (const s of wrapped) s.mockRestore();
    }
    expect(hasCalls).toEqual([]);
  });

  it('an ad card added to the rail later is still caught, through its anchor', async () => {
    const rail = document.querySelector('#rail') as HTMLElement;
    rail.insertAdjacentHTML(
      'beforeend',
      '<div id="ads2"><div><h3><span>Sponsored</span></h3></div><div><a aria-label="Advertiser" href="https://l.facebook.com/l.php?u=y">Zed</a></div></div>',
    );
    await settle();
    expect(document.querySelector('#ads2')?.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(document.querySelector('#rail')?.classList.contains(HIDDEN_CLASS)).toBe(false);
  });
});
