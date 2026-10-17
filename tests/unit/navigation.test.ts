import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

// In-app navigation on LinkedIn (feed -> company page -> Back, Notifications -> Home).
// The SPA swaps the page without a reload, and the batch that carries the new path
// usually carries the new page's posts too. Live (2026-10-17): that batch skipped the
// pre-paint lane, so on Back and on Home every post in it painted uncovered until the
// re-decide, ads included; and a post the reader had shown came back hidden, because
// the path change cleared mount memory. The scheduler is held throughout, so whatever
// is hidden before `drain()` was the lane.

const LINKEDIN = readFileSync(join(__dirname, '../../fixtures/public/linkedin-feed.html'), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(LINKEDIN)?.[1] ?? '';

function card(n: number): string {
  const doc = new DOMParser().parseFromString(LINKEDIN, 'text/html');
  const unit = doc.querySelector(`[componentkey^="update-card-focus${n}"]`);
  if (!unit?.parentElement) throw new Error(`no card ${n}`);
  return unit.parentElement.outerHTML;
}

// Fixture gold: 1001 and 1003 are organic, 1002 and 1006 sponsored, 1009 suggested.
const SHELL_1006 = () => card(1006).replace('<span>Gepromoot</span>', '<span></span>');

async function observed(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

const trustedClick = (el: HTMLElement) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
};

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.stop();
  scanner = undefined;
});

function site(start: string) {
  document.head.innerHTML = `<style>${style}</style>`;
  document.body.innerHTML = '<main><div data-testid="mainFeed" role="list"></div></main>';
  let path = start;
  const queue: Array<() => void> = [];
  scanner = new Scanner({
    doc: document,
    hostname: 'www.linkedin.com',
    baseUrl: 'https://www.linkedin.com/feed/',
    path: () => path,
    adapter: adapterFor('www.linkedin.com'),
    context: defaultContext('linkedin.com', { categories: { sponsored: true, suggested: true, custom: true } }),
    persistOverride: () => {},
    schedule: (fn) => void queue.push(fn),
    frame: () => undefined,
    now: () => 0,
  });
  const s = scanner;
  const drain = () => {
    for (let i = 0; queue.length && i < 1000; i++) queue.shift()!();
  };
  s.start();
  drain();
  const root = document.querySelector('[data-testid="mainFeed"]') as HTMLElement;
  const unitOf = (n: number) => document.querySelector(`[componentkey^="update-card-focus${n}"]`) as HTMLElement | null;
  return {
    s,
    drain,
    /** One mutation batch: the URL changes, the old posts go, the new ones arrive. */
    go: async (to: string, html: string) => {
      path = to;
      root.replaceChildren();
      root.insertAdjacentHTML('beforeend', html);
      await observed();
    },
    append: async (html: string) => {
      root.insertAdjacentHTML('beforeend', html);
      await observed();
    },
    unitOf,
    hidden: (n: number) => !!unitOf(n)?.classList.contains(HIDDEN_CLASS),
    perf: () => s.state().perf,
  };
}

describe('in-app navigation: the batch that carries the new path', () => {
  it('positive control: with no navigation, the lane hides a batch before the debounced pass', async () => {
    const f = site('/feed/');
    await f.append(card(1001) + card(1002) + card(1009));
    expect(f.hidden(1002)).toBe(true);
    expect(f.hidden(1009)).toBe(true);
    expect(f.hidden(1001)).toBe(false);
  });

  it('page -> feed (Back, Home): the new feed is hidden before its first paint', async () => {
    const f = site('/company/acme/');
    await f.append(card(1003));
    f.drain();
    await f.go('/feed/', card(1001) + card(1002) + card(1009));
    expect(f.hidden(1002), 'the ad, in the navigation batch itself').toBe(true);
    expect(f.hidden(1009), 'suggested, under the new path').toBe(true);
    expect(f.hidden(1001)).toBe(false);
    f.drain();
    expect(f.hidden(1002) && f.hidden(1009)).toBe(true);
    expect(f.hidden(1001)).toBe(false);
    expect(f.perf().laneReleases).toBe(0);
  });

  it('feed -> page: the lane reads under the new path, so suggested is not hidden there', async () => {
    const f = site('/feed/');
    await f.go('/company/acme/', card(1002) + card(1009));
    expect(f.hidden(1002), 'positive control: sponsored still hides off the feed').toBe(true);
    expect(f.hidden(1009)).toBe(false);
    f.drain();
    expect(f.hidden(1009)).toBe(false);
  });
});

describe('in-app navigation keeps mount memory', () => {
  it('a post the reader showed on the feed comes back shown after a page and Back', async () => {
    const f = site('/feed/');
    await f.append(card(1001) + card(1009));
    f.drain();
    expect(f.hidden(1009), 'positive control: the suggested post was hidden').toBe(true);
    trustedClick(f.unitOf(1009)!.firstElementChild!.shadowRoot!.querySelector('[data-act="show"]') as HTMLElement);
    expect(f.hidden(1009), 'Show worked').toBe(false);
    await f.go('/company/acme/', card(1003));
    f.drain();
    await f.go('/feed/', card(1001) + card(1009));
    expect(f.hidden(1009), 'not hidden again before paint').toBe(false);
    expect(f.unitOf(1009)!.firstElementChild?.shadowRoot?.querySelector('[data-act="hide"]'), 'its Hide bar is back').toBeTruthy();
    f.drain();
    expect(f.hidden(1009), 'nor by the re-decide').toBe(false);
  });

  it('a remembered ad is put back on another page, before its label fills in', async () => {
    const f = site('/feed/');
    await f.append(card(1006));
    f.drain();
    expect(f.hidden(1006), 'positive control').toBe(true);
    await f.go('/company/acme/', SHELL_1006());
    expect(f.hidden(1006), 'recalled across the navigation').toBe(true);
    expect(f.perf().laneRecalled).toBe(1);
  });

  it('a remembered suggested hide is not put back where suggested is off', async () => {
    const f = site('/feed/');
    await f.append(card(1009));
    f.drain();
    expect(f.hidden(1009), 'positive control').toBe(true);
    await f.go('/company/acme/', card(1009));
    expect(f.hidden(1009)).toBe(false);
    expect(f.perf().laneRecalled).toBe(0);
    f.drain();
    expect(f.hidden(1009)).toBe(false);
    expect(f.perf().laneReleases).toBe(0);
  });

  it('new settings still forget it (a context change, not a navigation)', async () => {
    const f = site('/feed/');
    await f.append(card(1006));
    f.drain();
    expect(f.hidden(1006), 'positive control').toBe(true);
    await f.go('/feed/', '');
    f.drain();
    f.s.applyContext(defaultContext('linkedin.com', { categories: { sponsored: true, suggested: true, custom: true } }));
    f.drain();
    await f.go('/feed/', SHELL_1006()); // same path: a re-mount, not a navigation
    expect(f.hidden(1006)).toBe(false);
    expect(f.perf().laneRecalled).toBe(0);
  });
});
