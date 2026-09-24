import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evalFixture, passes } from '../../evals/fixture-eval';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS, Hider, PLACEHOLDER_ATTR } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import type { SiteContext } from '../../src/messages';

const ctx = (over: Partial<SiteContext> = {}): SiteContext => ({
  siteKey: 'linkedin.com',
  enabled: true,
  pausedUntil: null,
  hideMode: 'collapse',
  overrides: {},
  ...over,
});

function button(unit: Element, act: string): HTMLElement {
  const host = unit.previousElementSibling;
  expect(host?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
  return host?.shadowRoot?.querySelector(`[data-act="${act}"]`) as HTMLElement;
}

describe('Hider', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul><li id="u" style="color: red">An ad</li></ul>';
  });

  it('hides without removing, and unhides back to the original style', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'collapse', { onShow: () => {}, onNotAd: () => {} });
    h.hide(u, 'sponsored');
    expect(u.isConnected).toBe(true);
    expect(u.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(u.style.getPropertyValue('display')).toBe('none');
    expect(u.previousElementSibling?.getAttribute(PLACEHOLDER_ATTR)).toBe('sponsored');
    h.unhide(u);
    expect(u.getAttribute('style')).toBe('color: red;');
    expect(u.classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
  });

  it('"hide" mode leaves no placeholder; switching mode restores one', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'hide', { onShow: () => {}, onNotAd: () => {} });
    h.hide(u, 'sponsored');
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    h.setMode('blur');
    expect(u.style.getPropertyValue('display')).toBe('');
    expect(u.style.getPropertyValue('filter')).toContain('blur');
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).not.toBeNull();
  });
});

describe('Scanner', () => {
  const html = readFileSync(join('fixtures', 'public', 'linkedin-feed.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

  function setup(context = ctx()) {
    document.head.innerHTML = `<style>${style}</style>`;
    document.body.innerHTML = body;
    const persisted: Array<[string, string | null]> = [];
    const scanner = new Scanner({
      doc: document,
      hostname: 'www.linkedin.com',
      baseUrl: 'https://www.linkedin.com/',
      adapter: adapterFor('www.linkedin.com'),
      context,
      persistOverride: (fp, action) => persisted.push([fp, action]),
      schedule: (fn) => fn(),
    });
    scanner.scanNow();
    const byKey = (k: string) => document.querySelector(`[componentkey^="update-card-focus${k}"]`) as HTMLElement;
    return { scanner, persisted, byKey };
  }

  it('hides the promoted units and counts them', () => {
    const { scanner, byKey } = setup();
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(byKey('1001').classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(scanner.state()).toMatchObject({ adapter: 'linkedin', counts: { sponsored: 3 }, hiddenNow: 3 });
  });

  it('Show reveals for this page only; nothing is persisted', () => {
    const { scanner, persisted, byKey } = setup();
    button(byKey('1002'), 'show').click();
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    scanner.applyContext(ctx()); // a full rescan must not re-hide it
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(persisted).toEqual([]);
  });

  it('Not an ad persists an override that survives a reload', () => {
    const first = setup();
    button(first.byKey('1002'), 'not-ad').click();
    expect(first.persisted).toHaveLength(1);
    const [fp, action] = first.persisted[0]!;
    expect(action).toBe('not-ad');
    expect(first.scanner.state().counts.sponsored).toBe(2);

    const reload = setup(ctx({ overrides: { [fp]: 'not-ad' } }));
    expect(reload.byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(reload.byKey('1004').classList.contains(HIDDEN_CLASS)).toBe(true);
  });

  it('a disabled site hides nothing, and disabling unhides', () => {
    expect(setup(ctx({ enabled: false })).scanner.state().hiddenNow).toBe(0);
    const { scanner } = setup();
    scanner.applyContext(ctx({ enabled: false }));
    expect(document.querySelectorAll(`.${HIDDEN_CLASS}`)).toHaveLength(0);
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`)).toHaveLength(0);
  });

  it('picks up units appended later (infinite scroll) after the debounce', async () => {
    vi.useFakeTimers();
    try {
      document.head.innerHTML = `<style>${style}</style>`;
      document.body.innerHTML = body;
      const scanner = new Scanner({
        doc: document,
        hostname: 'www.linkedin.com',
        baseUrl: 'https://www.linkedin.com/',
        adapter: adapterFor('www.linkedin.com'),
        context: ctx(),
        persistOverride: () => {},
      });
      scanner.start();
      const feed = document.querySelector('[data-testid="mainFeed"]') as HTMLElement;
      const extra = document.createElement('div');
      extra.innerHTML =
        '<div role="listitem" componentkey="update-card-focus2002x" id="late"><div><p componentkey="z1"><span>Late Co</span></p><p componentkey="z2"><span>Promoted</span></p></div><p componentkey="z3"><span>New ad body.</span></p></div>';
      feed.append(extra);
      const late = () => document.getElementById('late')?.classList.contains(HIDDEN_CLASS);
      await vi.advanceTimersByTimeAsync(100);
      expect(late()).toBe(false); // still inside the 250 ms debounce
      await vi.advanceTimersByTimeAsync(300);
      expect(late()).toBe(true);
      scanner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('public fixtures (same judge as pnpm eval:mock)', () => {
  const dir = join('fixtures', 'public');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    it(`${f}: every ad hidden, no organic unit hidden`, () => {
      const r = evalFixture(f, readFileSync(join(dir, f), 'utf8'));
      expect(r.units.filter((u) => u.hidden !== (u.gold === 'sponsored'))).toEqual([]);
      expect(r.unlabelledHidden).toEqual([]);
      expect(passes(r)).toBe(true);
    });
  }

  it('negative control: the judge fails when a label is wrong', () => {
    const html = readFileSync(join(dir, 'linkedin-feed.html'), 'utf8').replace(
      'update-card-focus1001FeedType_MAIN_FEED_RELEVANCE" data-gold="none"',
      'update-card-focus1001FeedType_MAIN_FEED_RELEVANCE" data-gold="sponsored"',
    );
    expect(passes(evalFixture('control', html))).toBe(false);
  });
});
