import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { MountMemory } from '../../src/content/mount-memory';
import { Scanner, type ScannerDeps } from '../../src/content/scanner';
import { defaultContext, type SiteContext } from '../../src/messages';

// Mount memory (scroll stability, Phase 1). A virtualised feed unmounts a post far
// from the screen and re-creates it, with the same `componentkey`, on the way back.
// The lane puts a remembered hide back in the re-mount's own MutationObserver callback,
// with no label read, so a shell whose label fills in later, or a unit the 1 ms cap
// would cut, still never paints at full height in a collapsed slot.

const LINKEDIN = readFileSync(join(__dirname, '../../fixtures/public/linkedin-feed.html'), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(LINKEDIN)?.[1] ?? '';

/** The fixture's card for post `n`, wrapper and all, as the site would insert it. */
function card(n: number): string {
  const doc = new DOMParser().parseFromString(LINKEDIN, 'text/html');
  const unit = doc.querySelector(`[componentkey^="update-card-focus${n}"]`);
  if (!unit?.parentElement) throw new Error(`no card ${n}`);
  return unit.parentElement.outerHTML;
}

/** Post 1006 (a Dutch "Gepromoot" ad) as a shell: same key, label not filled in yet. */
const SHELL_1006 = () => card(1006).replace('<span>Gepromoot</span>', '<span></span>');
/** The same key on an organic post: what a positional key would hand the memory. */
const ORGANIC_1006 = () => card(1006).replace('<span>Gepromoot</span>', '<span>Founder · 5h</span>');

const ctx = (over: Partial<SiteContext> = {}): SiteContext =>
  defaultContext('linkedin.com', { categories: { sponsored: true, suggested: true, custom: true }, ...over });

async function observed(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

const trustedClick = (el: HTMLElement) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
};

/** Makes the lane's read of post `n` take `costs[n]` ms on `clock` (as in prepaint.test.ts). Returns the undo. */
function slowReads(clock: { t: number }, costs: Record<number, number>): () => void {
  const proto = Scanner.prototype as unknown as { laneRead: (u: Element, ...rest: unknown[]) => unknown };
  const real = proto.laneRead;
  proto.laneRead = function (this: unknown, u: Element, ...rest: unknown[]) {
    const n = Number(/focus(\d+)/.exec(u.getAttribute('componentkey') ?? '')?.[1]);
    clock.t += costs[n] ?? 0;
    return real.call(this, u, ...rest);
  };
  return () => {
    proto.laneRead = real;
  };
}

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.stop();
  scanner = undefined;
});

function feed(over: Partial<ScannerDeps> = {}) {
  document.head.innerHTML = `<style>${style}</style>`;
  document.body.innerHTML = '<main><div data-testid="mainFeed" role="list"></div></main>';
  const queue: Array<() => void> = [];
  const frames: Array<() => void> = [];
  scanner = new Scanner({
    doc: document,
    hostname: 'www.linkedin.com',
    baseUrl: 'https://www.linkedin.com/feed/',
    adapter: adapterFor('www.linkedin.com'),
    context: ctx(),
    persistOverride: () => {},
    schedule: (fn) => void queue.push(fn),
    frame: (fn) => void frames.push(fn),
    now: () => 0,
    ...over,
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
    frames,
    append: (html: string) => root.insertAdjacentHTML('beforeend', html),
    /** The site unmounting post `n`: its wrapper goes, its key stays in the site's own list. */
    unmount: (n: number) => unitOf(n)!.parentElement!.remove(),
    unitOf,
    hidden: (n: number) => !!unitOf(n)?.classList.contains(HIDDEN_CLASS),
    perf: () => s.state().perf,
  };
}

/** Mounts post 1006, lets the full decision confirm its hide, then unmounts it. */
async function seenThenUnmounted(f: ReturnType<typeof feed>): Promise<void> {
  f.append(card(1001) + card(1006));
  await observed();
  f.drain();
  expect(f.hidden(1006), 'positive control: the ad was hidden before it left').toBe(true);
  f.unmount(1006);
  await observed();
  f.drain();
}

describe('MountMemory', () => {
  const unit = (key: string | null) => {
    const el = document.createElement('div');
    if (key !== null) el.setAttribute('componentkey', key);
    return el;
  };

  it('remembers by key, so a new element with the same key gets the record', () => {
    const m = new MountMemory('componentkey');
    m.set(unit('a'), { state: 'hidden', category: 'sponsored' });
    expect(m.get(unit('a'))).toEqual({ state: 'hidden', category: 'sponsored' });
    expect(m.get(unit('b'))).toBeUndefined();
  });

  it('ignores an element without the key', () => {
    const m = new MountMemory('componentkey');
    m.set(unit(null), { state: 'hidden', category: 'sponsored' });
    m.set(unit(''), { state: 'hidden', category: 'sponsored' });
    expect(m.size).toBe(0);
    expect(m.get(unit(null))).toBeUndefined();
  });

  it('forgets on null, and drops the least recently written first', () => {
    const m = new MountMemory('componentkey', 2);
    m.set(unit('a'), { state: 'hidden', category: 'sponsored' });
    m.set(unit('b'), { state: 'hidden', category: 'sponsored' });
    m.set(unit('a'), { state: 'shown', category: 'sponsored' });
    m.set(unit('c'), { state: 'hidden', category: 'suggested' });
    expect(m.size).toBe(2);
    expect(m.get(unit('b')), 'b was the oldest write').toBeUndefined();
    expect(m.get(unit('a'))?.state).toBe('shown');
    m.set(unit('a'), null);
    expect(m.get(unit('a'))).toBeUndefined();
    m.clear();
    expect(m.size).toBe(0);
  });
});

describe('mount memory in the pre-paint lane', () => {
  it('a re-mounted ad whose label is not filled in yet is hidden before its first paint', async () => {
    const f = feed();
    await seenThenUnmounted(f);
    f.append(SHELL_1006());
    await observed();
    expect(f.hidden(1006), 'hidden in the re-mount callback, with no label to read').toBe(true);
    expect(f.perf().laneRecalled).toBe(1);
    // The label fills in, and the full decision confirms the recall.
    f.unitOf(1006)!.querySelector('p[componentkey="c-17"] > span')!.textContent = 'Gepromoot';
    await observed();
    f.drain();
    expect(f.hidden(1006)).toBe(true);
    expect(f.perf().laneReleases).toBe(0);
  });

  it('negative control: without a unitKey the same shell paints, and only the debounced pass hides it', async () => {
    const adapter = { ...adapterFor('www.linkedin.com')!, unitKey: undefined };
    const f = feed({ adapter });
    await seenThenUnmounted(f);
    f.append(SHELL_1006());
    await observed();
    expect(f.hidden(1006)).toBe(false);
    expect(f.perf().laneRecalled).toBe(0);
  });

  it('a recall the full decision disagrees with is released in place (a key reused for another post)', async () => {
    const f = feed();
    await seenThenUnmounted(f);
    f.append(ORGANIC_1006());
    await observed();
    expect(f.hidden(1006), 'the lane trusts the key before paint').toBe(true);
    f.drain();
    expect(f.hidden(1006), 'decide() reads the post and puts it back').toBe(false);
    expect(f.perf().laneReleases).toBe(1);
    // Released means forgotten: the next re-mount is read afresh.
    f.unmount(1006);
    await observed();
    f.drain();
    f.append(ORGANIC_1006());
    await observed();
    expect(f.hidden(1006)).toBe(false);
  });

  it('is not capped: a remembered unit the 1 ms would cut is still put back in the same callback', async () => {
    const clock = { t: 0 };
    const restore = slowReads(clock, { 1006: 50, 1001: 2 });
    try {
      const f = feed({ now: () => clock.t });
      f.append(card(1006) + card(1001) + card(1004));
      await observed();
      expect(f.hidden(1004), 'positive control: the first mount cuts 1004 to the next frame').toBe(false);
      f.frames.splice(0).forEach((fn) => fn());
      f.drain();
      expect(f.hidden(1006) && f.hidden(1004)).toBe(true);
      for (const n of [1006, 1001, 1004]) f.unmount(n);
      await observed();
      f.drain();
      f.append(card(1006) + card(1001) + card(1004));
      await observed();
      expect(f.hidden(1006)).toBe(true);
      expect(f.hidden(1004), 'recalled, not cut').toBe(true);
      expect(f.hidden(1001)).toBe(false);
      expect(f.frames).toEqual([]);
      expect(f.perf().laneRecalled).toBe(2);
    } finally {
      restore();
    }
  });

  it('a post the reader showed comes back shown, not collapsed', async () => {
    const f = feed();
    await seenThenUnmounted(f);
    f.append(card(1006));
    await observed();
    f.drain();
    const host = f.unitOf(1006)!.firstElementChild!;
    trustedClick(host.shadowRoot!.querySelector('[data-act="show"]') as HTMLElement);
    expect(f.hidden(1006), 'positive control: Show worked').toBe(false);
    f.unmount(1006);
    await observed();
    f.drain();
    f.append(card(1006));
    await observed();
    expect(f.hidden(1006), 'not collapsed again before paint').toBe(false);
    expect(f.unitOf(1006)!.firstElementChild!.shadowRoot!.querySelector('[data-act="hide"]'), 'its Hide bar is back').not.toBeNull();
    f.drain();
    expect(f.hidden(1006)).toBe(false);
    expect(f.s.state().counts, 'a shown post is out of the counts').toEqual({});
  });

  it('new settings forget what was hidden under the old ones', async () => {
    const f = feed();
    await seenThenUnmounted(f);
    f.s.applyContext(ctx());
    f.drain();
    f.append(SHELL_1006());
    await observed();
    expect(f.hidden(1006)).toBe(false);
    expect(f.perf().laneRecalled).toBe(0);
  });
});
