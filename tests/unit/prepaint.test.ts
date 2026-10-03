import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePath } from '../../evals/fixture-eval';
import { adapterFor } from '../../src/adapters/index';
import type { Adapter } from '../../src/adapters/schema';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner, type ScannerDeps } from '../../src/content/scanner';
import type { HideTrace } from '../../src/content/trace';
import { unitText } from '../../src/extract';
import { fingerprint } from '../../src/fingerprint';
import { defaultContext, type SiteContext } from '../../src/messages';

// The pre-paint lane (hard rule 7's exception): a unit born in a mutation batch with
// its marker already in it is hidden in that batch's MutationObserver callback, a
// microtask before the browser paints. These tests tell the lane apart from the
// debounced pass by holding every scheduled callback in a queue: whatever is hidden
// before `drain()` was hidden by the lane.

const FIXTURES = join(__dirname, '../../fixtures/public');
const LINKEDIN = readFileSync(join(FIXTURES, 'linkedin-feed.html'), 'utf8');

/** The fixture's card for post `n` (1001...), wrapper and all, as the site would insert it. */
function card(n: number): string {
  const doc = new DOMParser().parseFromString(LINKEDIN, 'text/html');
  const unit = doc.querySelector(`[componentkey^="update-card-focus${n}"]`);
  if (!unit?.parentElement) throw new Error(`no card ${n}`);
  return unit.parentElement.outerHTML;
}

const style = /<style>([\s\S]*?)<\/style>/.exec(LINKEDIN)?.[1] ?? '';
const ctx = (over: Partial<SiteContext> = {}): SiteContext =>
  defaultContext('linkedin.com', { categories: { sponsored: true, suggested: true, custom: true }, ...over });

/** Microtasks, so the MutationObserver has delivered. No timer runs. */
async function observed(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.stop();
  scanner = undefined;
});

/** An empty LinkedIn feed with the scanner running, and a queue standing in for the debounce and idle slices. */
function feed(over: Partial<ScannerDeps> = {}, context = ctx()) {
  document.head.innerHTML = `<style>${style}</style>`;
  document.body.innerHTML = '<main><div data-testid="mainFeed" role="list"></div></main>';
  const queue: Array<() => void> = [];
  scanner = new Scanner({
    doc: document,
    hostname: 'www.linkedin.com',
    baseUrl: 'https://www.linkedin.com/feed/',
    adapter: adapterFor('www.linkedin.com'),
    context,
    persistOverride: () => {},
    schedule: (fn) => void queue.push(fn),
    // happy-dom's style reads cost milliseconds: a frozen clock keeps the 1 ms cap out of
    // tests about what the lane decides. The budget has its own test.
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
  return {
    s,
    drain,
    append: (html: string) => root.insertAdjacentHTML('beforeend', html),
    hidden: (n: number) => !!document.querySelector(`[componentkey^="update-card-focus${n}"]`)?.classList.contains(HIDDEN_CLASS),
    perf: () => s.state().perf,
  };
}

describe('pre-paint lane', () => {
  it('hides an ad born with its label in the same callback, before any debounce', async () => {
    const f = feed();
    f.append(card(1001) + card(1006));
    expect(f.hidden(1006), 'the observer has not run yet').toBe(false);
    await observed();
    expect(f.hidden(1006)).toBe(true);
    expect(f.hidden(1001), 'an organic post beside it is untouched').toBe(false);
    expect(f.perf()).toMatchObject({ laneHits: 1, laneReleases: 0 });
    f.drain();
    expect(f.hidden(1006), 'the debounced pass confirms it').toBe(true);
    expect(f.hidden(1001)).toBe(false);
    expect(f.perf().laneReleases).toBe(0);
  });

  it('reads a label split around a hidden decoy the way decide() does', async () => {
    const f = feed();
    f.append(card(1004));
    await observed();
    expect(f.hidden(1004)).toBe(true);
  });

  // fixtures/public/linkedin-feed.html: a "Promoted" the site hides with a class.
  it('leaves an organic post with a hidden "Promoted" alone', async () => {
    const f = feed();
    f.append(card(1005) + card(1006));
    await observed();
    expect(f.hidden(1006), 'positive control: the ad in the same batch').toBe(true);
    expect(f.hidden(1005)).toBe(false);
    f.drain();
    expect(f.hidden(1005)).toBe(false);
  });

  it('a card filled in after it was mounted takes the debounced pass', async () => {
    const f = feed();
    f.append('<div data-lazy-mount-id="x"><div role="listitem" componentkey="update-card-focus2001x"><div><p componentkey="q1"><span>Acme</span></p></div></div></div>');
    await observed();
    const unit = document.querySelector('[componentkey="update-card-focus2001x"]') as HTMLElement;
    (unit.firstElementChild as HTMLElement).insertAdjacentHTML('beforeend', '<p componentkey="q2"><span>Promoted</span></p><p componentkey="q3"><span>Buy now.</span></p>');
    await observed();
    expect(f.hidden(2001), 'it may already be on screen: not the lane\'s').toBe(false);
    expect(f.perf().laneHits).toBe(0);
    f.drain();
    expect(f.hidden(2001), 'positive control: the debounced pass hides it').toBe(true);
  });

  it('over budget, takes the first unit and leaves the rest of the batch to the debounced pass', async () => {
    let t = 0;
    const f = feed({ now: () => (t += 2) });
    f.append(card(1006) + card(1004));
    await observed();
    expect(f.hidden(1006), 'the first unit always fits').toBe(true);
    expect(f.hidden(1004)).toBe(false);
    expect(f.perf()).toMatchObject({ laneHits: 1, laneOverBudget: 1 });
    f.drain();
    expect(f.hidden(1004), 'positive control: the debounced pass hides the rest').toBe(true);
  });

  // The trace's arrival class needs the lane to say what it left behind, and why.
  it('tells the trace which units it cut, abstained on, or saw born empty', async () => {
    const calls: string[] = [];
    const key = (u: Element) => u.getAttribute('componentkey')?.slice(17, 21) ?? '?';
    const noop = () => {};
    const trace: HideTrace = {
      dirty: noop, due: noop, takeDirty: () => 0, queued: noop, empty: noop, hid: noop, released: noop,
      shown: noop, unshown: noop, sweep: noop, reset: noop,
      stats: () => ({}) as ReturnType<HideTrace['stats']>,
      bornBare: (u) => calls.push(`bare ${key(u)}`),
      laneSkipped: (u, why) => calls.push(`${why} ${key(u)}`),
    };
    let t = 0;
    const f = feed({ trace, now: () => (t += 2) });
    f.append(card(1006) + card(1004));
    await observed();
    expect(f.hidden(1006), 'positive control: the first unit fit').toBe(true);
    expect(calls).toEqual(['overflow 1004']);
    f.s.stop();
    calls.length = 0;
    const g = feed({ trace });
    g.append('<div><div role="listitem" componentkey="update-card-focus3001x"></div></div>');
    await observed();
    expect(calls).toEqual(['bare 3001']);
  });

  it('over budget, stops collecting after the first record', async () => {
    let t = 0;
    const f = feed({ now: () => (t += 2) });
    // Two records in one batch: the second is never looked at.
    f.append(card(1006));
    f.append(card(1004));
    await observed();
    expect(f.hidden(1006)).toBe(true);
    expect(f.hidden(1004)).toBe(false);
    expect(f.perf().laneOverBudget).toBe(1);
    f.drain();
    expect(f.hidden(1004)).toBe(true);
  });

  it('a lane hide the debounced pass disagrees with is released and counted', async () => {
    const f = feed();
    f.append(card(1006));
    await observed();
    expect(f.hidden(1006)).toBe(true);
    // The site recycles the node for an organic post before the debounced pass runs.
    const label = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Gepromoot') as HTMLElement;
    label.textContent = 'Product lead · 1h';
    await observed();
    f.drain();
    expect(f.hidden(1006)).toBe(false);
    expect(f.perf().laneReleases).toBe(1);
  });

  it('honours "Not an ad" on the post', async () => {
    // The fingerprint of the card as the site built it, read once with no scanner running.
    document.body.innerHTML = card(1006);
    const unit = document.querySelector('[role="listitem"]') as Element;
    const fp = fingerprint('linkedin.com', unitText(unit, adapterFor('www.linkedin.com')!));
    const f = feed({}, ctx({ overrides: { [fp]: 'not-ad' } }));
    f.append(card(1004) + card(1006));
    await observed();
    expect(f.hidden(1004), 'positive control').toBe(true);
    expect(f.hidden(1006)).toBe(false);
    expect(f.perf().laneAbstain).toBeGreaterThan(0);
  });

  it('honours a switched-off suggested rule and what it covers', async () => {
    const f = feed({}, ctx({ offRules: ['activity'] }));
    f.append(card(1011) + card(1012) + card(1013));
    await observed();
    expect(f.hidden(1013), 'positive control: a stranger\'s post, "follow" is still on').toBe(true);
    expect(f.hidden(1011), 'liked by a connection: "activity" is off').toBe(false);
    expect(f.hidden(1012), '"activity" covers its Follow button').toBe(false);
  });

  it('honours suggestedPaths: no suggested hides on a company page', async () => {
    const f = feed({ baseUrl: 'https://www.linkedin.com/company/acme/' });
    f.append(card(1006) + card(1013));
    await observed();
    expect(f.hidden(1006), 'positive control: sponsored still applies').toBe(true);
    expect(f.hidden(1013)).toBe(false);
  });

  it('is off where the adapter does not ask for it, and when the scanner is told so', async () => {
    const linkedin = adapterFor('www.linkedin.com') as Adapter;
    for (const over of [{ adapter: { ...linkedin, prepaint: false } }, { prepaint: false }] as Partial<ScannerDeps>[]) {
      const f = feed(over);
      f.append(card(1006));
      await observed();
      expect(f.hidden(1006)).toBe(false);
      f.drain();
      expect(f.hidden(1006), 'positive control').toBe(true);
      scanner?.stop();
      scanner = undefined;
    }
  });

  it('is off while the scanner is paused', async () => {
    const f = feed({}, ctx({ pausedUntil: Date.now() + 60_000 }));
    f.append(card(1006));
    await observed();
    expect(f.hidden(1006)).toBe(false);
  });
});

// Parity: the lane may only make hides decide() makes too. Every public fixture,
// every unit born in one batch, the lane forced on wherever it can run.

const ALL = { sponsored: true, suggested: true, custom: true };

async function laneRun(html: string) {
  const host = /<meta\s+name="sifter-host"\s+content="([^"]+)"/.exec(html)?.[1] as string;
  const url = `https://${host}${fixturePath(html)}`;
  const window = new Window({ url, settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true } });
  try {
    const doc = window.document as unknown as Document;
    doc.write(html);
    const content = doc.body.innerHTML;
    doc.body.innerHTML = '';
    const adapter = { ...(adapterFor(host) as Adapter), prepaint: true };
    const queue: Array<() => void> = [];
    const s = new Scanner({
      doc,
      hostname: host,
      baseUrl: url,
      adapter,
      context: defaultContext(new URL(url).hostname.replace(/^www\./, ''), { categories: { ...ALL } }),
      persistOverride: () => {},
      schedule: (fn) => void queue.push(fn),
      now: () => 0,
    });
    s.start();
    doc.body.innerHTML = content;
    await observed();
    const byLane = [...doc.querySelectorAll(`.${HIDDEN_CLASS}`)];
    for (let i = 0; queue.length && i < 5000; i++) queue.shift()!();
    const result = {
      container: !!adapter.adContainerSelector,
      byLane: byLane.map((u) => u.getAttribute('data-gold')),
      stillHidden: byLane.every((u) => u.classList.contains(HIDDEN_CLASS)),
      perf: s.state().perf,
    };
    s.stop();
    return result;
  } finally {
    void window.happyDOM.close();
  }
}

describe('pre-paint lane parity with decide()', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));
  for (const file of files) {
    it(file, async () => {
      const r = await laneRun(readFileSync(join(FIXTURES, file), 'utf8'));
      if (r.container) {
        // Google's ad containers hide as the outermost box: the lane stays out.
        expect(r.byLane).toEqual([]);
        return;
      }
      expect(r.byLane.length, 'positive control: the lane caught something').toBeGreaterThan(0);
      for (const gold of r.byLane) expect(['sponsored', 'suggested']).toContain(gold);
      expect(r.stillHidden, 'decide() kept every lane hide').toBe(true);
      expect(r.perf.laneReleases).toBe(0);
    });
  }
});
