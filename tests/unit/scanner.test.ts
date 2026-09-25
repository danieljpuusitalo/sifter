import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evalFixture, passes, PASSES } from '../../evals/fixture-eval';
import { adapterFor } from '../../src/adapters/index';
import {
  BLUR_CLASS,
  COLLAPSE_CLASS,
  HIDDEN_CLASS,
  Hider,
  PLACEHOLDER_ATTR,
  placeholderRoot,
  unitStylesheetText,
  usesSharedSheet,
} from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext, type SiteContext } from '../../src/messages';

const ctx = (over: Partial<SiteContext> = {}): SiteContext => defaultContext('linkedin.com', over);
const noopCb = { onShow: () => {}, onNotAd: () => {}, onRehide: () => {} };

/** The placeholder now lives inside the unit, as its first child. */
function button(unit: Element, act: string): HTMLElement {
  const host = unit.firstElementChild;
  expect(host?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
  return host?.shadowRoot?.querySelector(`[data-act="${act}"]`) as HTMLElement;
}

/** The placeholder ignores synthetic clicks (isTrusted=false), so stand in for a real one. */
function userClick(el: HTMLElement): void {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
}

describe('Hider', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul><li id="u" style="color: red">An ad</li></ul>';
  });

  it('hides without removing, and unhides back to the original style', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'collapse', noopCb);
    h.hide(u, 'sponsored');
    expect(u.isConnected).toBe(true);
    expect(u.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(u.classList.contains(COLLAPSE_CLASS)).toBe(true);
    // The bug this fixes: a virtualised feed measures a display:none unit at 0 px
    // and parks it (and any previous-sibling placeholder) off-screen. So the unit
    // itself gets no inline display; only its children (not the placeholder) do,
    // from the shared document stylesheet.
    expect(u.style.getPropertyValue('display')).toBe('');
    expect(u.firstElementChild?.getAttribute(PLACEHOLDER_ATTR)).toBe('sponsored');
    expect(unitStylesheetText(document)).toContain(`.${HIDDEN_CLASS}.${COLLAPSE_CLASS} > :not([${PLACEHOLDER_ATTR}])`);
    h.unhide(u);
    expect(u.getAttribute('style')).toBe('color: red');
    expect(u.classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(u.classList.contains(COLLAPSE_CLASS)).toBe(false);
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
  });

  it('blur mode styles children (and blurs them), not the placeholder, from the shared sheet', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'blur', noopCb);
    h.hide(u, 'sponsored');
    expect(u.classList.contains(BLUR_CLASS)).toBe(true);
    expect(u.style.getPropertyValue('filter')).toBe('');
    expect(unitStylesheetText(document)).toContain(`.${HIDDEN_CLASS}.${BLUR_CLASS} > :not([${PLACEHOLDER_ATTR}])`);
    expect(unitStylesheetText(document)).toContain('blur(12px)');
  });

  it('"hide" mode leaves no placeholder; switching mode restores one', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'hide', noopCb);
    h.hide(u, 'sponsored');
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    expect(u.style.getPropertyValue('display')).toBe('none');
    h.setMode('blur');
    expect(u.style.getPropertyValue('display')).toBe('');
    expect(u.classList.contains(BLUR_CLASS)).toBe(true);
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).not.toBeNull();
  });

  it('placeholders share one constructed stylesheet instead of a <style> each', () => {
    document.body.innerHTML = '<ul><li id="a">Ad one</li><li id="b">Ad two</li></ul>';
    const h = new Hider(document, 'collapse', noopCb);
    h.hide(document.getElementById('a') as HTMLElement, 'sponsored');
    h.hide(document.getElementById('b') as HTMLElement, 'suggested');
    const hosts = Array.from(document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`));
    expect(hosts).toHaveLength(2);
    // Positive control: happy-dom supports constructable sheets, so the shared path is on.
    expect(usesSharedSheet(document)).toBe(true);
    const roots = hosts.map((host) => placeholderRoot(host)!);
    for (const root of roots) {
      expect(root.querySelector('style')).toBeNull();
      expect(root.adoptedStyleSheets).toHaveLength(1);
      expect(root.querySelector('.row')).not.toBeNull();
    }
    expect(roots[0]!.adoptedStyleSheets[0]).toBe(roots[1]!.adoptedStyleSheets[0]);
  });

  it('hint appears in the label after a middle dot, capped to what the caller sent', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'collapse', noopCb);
    h.hide(u, 'sponsored', 'Remedy Entertainment');
    const label = u.firstElementChild?.shadowRoot?.querySelector('.label');
    expect(label?.textContent).toBe('Hidden sponsored post · Remedy Entertainment');
  });

  it('Show keeps a Hide button and drops out of hiddenUnits(); Hide re-hides', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'collapse', noopCb);
    h.hide(u, 'sponsored');
    expect(h.hiddenUnits()).toEqual([u]);
    h.show(u);
    expect(h.hiddenUnits()).toEqual([]);
    expect(u.classList.contains(HIDDEN_CLASS)).toBe(false);
    const hideBtn = u.firstElementChild?.shadowRoot?.querySelector('[data-act="hide"]');
    expect(hideBtn).not.toBeNull();
    expect(u.firstElementChild?.shadowRoot?.querySelector('[data-act="show"]')).toBeNull();
    const label = u.firstElementChild?.shadowRoot?.querySelector('.label');
    expect(label?.textContent).toBe('Showing hidden sponsored post');

    h.rehide(u);
    expect(h.hiddenUnits()).toEqual([u]);
    expect(u.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(u.firstElementChild?.shadowRoot?.querySelector('[data-act="show"]')).not.toBeNull();
  });

  it('"Not an ad" after Show removes the placeholder entirely', () => {
    const u = document.getElementById('u') as HTMLElement;
    const notAdUnits: Element[] = [];
    const h = new Hider(document, 'collapse', { onShow: () => {}, onNotAd: (unit) => notAdUnits.push(unit), onRehide: () => {} });
    h.hide(u, 'sponsored');
    h.show(u);
    userClick(u.firstElementChild!.shadowRoot!.querySelector('[data-act="not-ad"]') as HTMLElement);
    expect(notAdUnits).toEqual([u]);
    h.unhide(u);
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    expect(h.isHidden(u)).toBe(false);
  });

  it('prune re-seats a placeholder moved out of its unit', () => {
    const u = document.getElementById('u') as HTMLElement;
    const h = new Hider(document, 'collapse', noopCb);
    h.hide(u, 'sponsored');
    const placeholder = u.firstElementChild as HTMLElement;
    u.parentElement?.append(placeholder); // knock it out to be a sibling again
    expect(u.firstElementChild).toBeNull();
    h.prune();
    expect(u.firstElementChild).toBe(placeholder);
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
    userClick(button(byKey('1002'), 'show'));
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(scanner.state().hiddenNow).toBe(2); // dropped out of the count, but still tracked
    scanner.applyContext(ctx()); // a full rescan must not re-hide it
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(persisted).toEqual([]);
  });

  it('Hide re-hides a shown unit, and a full rescan keeps it hidden', () => {
    const { scanner, byKey } = setup();
    userClick(button(byKey('1002'), 'show'));
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(false);
    userClick(button(byKey('1002'), 'hide'));
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(scanner.state().hiddenNow).toBe(3);
    scanner.applyContext(ctx());
    expect(byKey('1002').classList.contains(HIDDEN_CLASS)).toBe(true);
  });

  it('"Not an ad" after Show removes the placeholder entirely and persists', () => {
    const { persisted, byKey } = setup();
    userClick(button(byKey('1002'), 'show'));
    userClick(button(byKey('1002'), 'not-ad'));
    expect(byKey('1002').querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]![1]).toBe('not-ad');
  });

  it('Not an ad persists an override that survives a reload', () => {
    const first = setup();
    userClick(button(first.byKey('1002'), 'not-ad'));
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
      // The first pass runs in an idle slice, not in start() itself: let it finish
      // before appending, so what follows is the incremental path.
      await vi.advanceTimersByTimeAsync(50);
      expect(scanner.state().hiddenNow).toBe(3); // positive control: the first pass ran
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
    for (const p of PASSES) {
      it(`${f} [${p.name}]: every expected unit hidden, nothing else`, () => {
        const r = evalFixture(f, readFileSync(join(dir, f), 'utf8'), p.categories);
        expect(r.units.filter((u) => u.hidden !== u.expected)).toEqual([]);
        expect(r.unlabelledHidden).toEqual([]);
        expect(passes(r)).toBe(true);
      });
    }
  }

  it('negative control: the judge fails when a label is wrong', () => {
    const html = readFileSync(join(dir, 'linkedin-feed.html'), 'utf8').replace(
      'update-card-focus1001FeedType_MAIN_FEED_RELEVANCE" data-gold="none"',
      'update-card-focus1001FeedType_MAIN_FEED_RELEVANCE" data-gold="sponsored"',
    );
    expect(passes(evalFixture('control', html))).toBe(false);
  });
});
