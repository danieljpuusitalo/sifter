import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixturePath } from '../../evals/fixture-eval';
import { adapterFor } from '../../src/adapters/index';
import {
  BLUR_CLASS,
  COLLAPSE_CLASS,
  HIDDEN_CLASS,
  Hider,
  PLACEHOLDER_ATTR,
  VEIL_CLASS,
  placeholderRoot,
  unitStylesheetText,
} from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { EMPTY_VEIL_STATS, type VeilTracker } from '../../src/content/viewport';
import { hasContent, renderedText, renderedWithin } from '../../src/extract';
import { defaultContext } from '../../src/messages';
import { siteKey } from '../../src/storage/settings';
import type { CategoryToggles } from '../../src/types';

// The veil: a hide on screen keeps the unit's height, and collapses only once the
// viewport tracker says the unit is off screen (src/content/viewport.ts). These
// tests drive a fake tracker by hand; the real one is covered end to end in
// tests/e2e/stability.spec.ts.

const noopCb = { onShow: () => {}, onNotAd: () => {}, onRehide: () => {} };

/** A tracker that never settles on its own: the test decides when a unit is off screen. */
class FakeTracker implements VeilTracker {
  watched = new Set<Element>();
  settle: (unit: Element) => void = () => {};
  watch(unit: Element): void {
    this.watched.add(unit);
  }
  unwatch(unit: Element): void {
    this.watched.delete(unit);
  }
  stats() {
    return { ...EMPTY_VEIL_STATS };
  }
  disconnect(): void {
    this.watched.clear();
  }
  loading = false;
  loadHide(): boolean {
    return this.loading;
  }
  /** Stand-in for the IntersectionObserver reporting every watched unit off screen. */
  offScreen(): void {
    for (const u of [...this.watched]) this.settle(u);
  }
}

function button(unit: Element, act: string): HTMLElement {
  const host = unit.firstElementChild;
  expect(host?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
  return placeholderRoot(host as Element)?.querySelector(`[data-act="${act}"]`) as HTMLElement;
}

function userClick(el: HTMLElement): void {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
}

function veiledHider(mode: 'collapse' | 'blur' | 'hide' = 'collapse') {
  const t = new FakeTracker();
  const h = new Hider(document, mode, noopCb, t);
  t.settle = (u) => h.settle(u);
  return { h, t };
}

describe('Hider veil', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul><li id="u" style="color: red"><span class="label">Promoted</span><p>An ad</p></li></ul>';
  });
  const unit = () => document.getElementById('u') as HTMLElement;

  it('a new hide lands veiled: no mode class, no inline display, placeholder in, tracker watching', () => {
    const { h, t } = veiledHider();
    h.hide(unit(), 'sponsored');
    expect(h.isHidden(unit())).toBe(true);
    expect(h.isVeiled(unit())).toBe(true);
    expect(unit().classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(unit().classList.contains(VEIL_CLASS)).toBe(true);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(false);
    expect(unit().style.getPropertyValue('display')).toBe('');
    expect(unit().firstElementChild?.getAttribute(PLACEHOLDER_ATTR)).toBe('sponsored');
    expect(t.watched.has(unit())).toBe(true);
    // Still counted as hidden for the popup.
    expect(h.hiddenUnits()).toEqual([unit()]);
  });

  // Google, 2026-10-01: the ad block above the results veiled at load and left a
  // blank band at the top until the reader scrolled. Nobody is reading yet at load.
  it('a hide while the tracker says the page is loading skips the veil and collapses at once', () => {
    const { h, t } = veiledHider();
    t.loading = true;
    h.hide(unit(), 'sponsored');
    expect(h.isHidden(unit())).toBe(true);
    expect(h.isVeiled(unit())).toBe(false);
    expect(unit().classList.contains(VEIL_CLASS)).toBe(false);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(t.watched.has(unit())).toBe(false);
  });

  it('the veil CSS clips instead of hiding, and lays the placeholder over the content at zero height', () => {
    const { h } = veiledHider();
    h.hide(unit(), 'sponsored');
    const css = unitStylesheetText(document);
    expect(css).toContain(`.${HIDDEN_CLASS}.${VEIL_CLASS} > :not([${PLACEHOLDER_ATTR}])`);
    expect(css).toMatch(/clip-path: inset\(0(px)? 0(px)? 100% 0(px)?\) !important/);
    expect(css).toMatch(/height: 0(px)? !important/);
    // The contract with extract.ts: nothing in the veil rules may touch what the readers read.
    const veilRules = css.split('\n').filter((l) => l.includes(VEIL_CLASS));
    for (const rule of veilRules) {
      expect(rule).not.toMatch(/display:\s*none|visibility|opacity/);
    }
  });

  it('settle applies the real mode and stops watching', () => {
    const { h, t } = veiledHider();
    h.hide(unit(), 'sponsored');
    t.offScreen();
    expect(h.isVeiled(unit())).toBe(false);
    expect(unit().classList.contains(VEIL_CLASS)).toBe(false);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(t.watched.size).toBe(0);
    // A second settle is a no-op.
    h.settle(unit());
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
  });

  it('hide mode: veiled with no placeholder, display:none only on settle, and unhide restores the style', () => {
    const { h, t } = veiledHider('hide');
    h.hide(unit(), 'sponsored');
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    expect(unit().style.getPropertyValue('display')).toBe('');
    expect(unit().classList.contains(VEIL_CLASS)).toBe(true);
    t.offScreen();
    expect(unit().style.getPropertyValue('display')).toBe('none');
    h.unhide(unit());
    expect(unit().style.getPropertyValue('display')).toBe('');
    expect(unit().style.getPropertyValue('color')).toBe('red');
  });

  it('blur mode settles into blur, and its placeholder stays zero-height (blur never shifts)', () => {
    const { h, t } = veiledHider('blur');
    h.hide(unit(), 'sponsored');
    t.offScreen();
    expect(unit().classList.contains(BLUR_CLASS)).toBe(true);
    expect(unitStylesheetText(document)).toContain(`.${HIDDEN_CLASS}.${BLUR_CLASS} > [${PLACEHOLDER_ATTR}]`);
  });

  it('setMode while veiled keeps the veil and settles into the new mode', () => {
    const { h, t } = veiledHider('collapse');
    h.hide(unit(), 'sponsored');
    h.setMode('hide');
    expect(h.isVeiled(unit())).toBe(true);
    expect(unit().classList.contains(VEIL_CLASS)).toBe(true);
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    expect(unit().style.getPropertyValue('display')).toBe('');
    h.setMode('blur');
    expect(unit().classList.contains(VEIL_CLASS)).toBe(true);
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`).length).toBe(1);
    t.offScreen();
    expect(unit().classList.contains(BLUR_CLASS)).toBe(true);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(false);
    expect(unit().style.getPropertyValue('display')).toBe('');
    h.unhide(unit());
    expect(unit().className).toBe('');
    expect(unit().getAttribute('style')).toBe('color: red');
  });

  it('setMode after settle presents the new mode at once, as before', () => {
    const { h, t } = veiledHider('collapse');
    h.hide(unit(), 'sponsored');
    t.offScreen();
    h.setMode('blur');
    expect(unit().classList.contains(VEIL_CLASS)).toBe(false);
    expect(unit().classList.contains(BLUR_CLASS)).toBe(true);
    expect(t.watched.size).toBe(0);
  });

  it('Show on a veiled unit lifts the veil for good; Hide after it collapses at once', () => {
    const t = new FakeTracker();
    const h: Hider = new Hider(
      document,
      'collapse',
      { onShow: (u) => h.show(u), onNotAd: () => {}, onRehide: (u) => h.rehide(u) },
      t,
    );
    t.settle = (u) => h.settle(u);
    h.hide(unit(), 'sponsored');
    userClick(button(unit(), 'show'));
    expect(unit().classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(unit().classList.contains(VEIL_CLASS)).toBe(false);
    expect(h.isVeiled(unit())).toBe(false);
    expect(t.watched.size).toBe(0);
    userClick(button(unit(), 'hide'));
    expect(unit().classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(unit().classList.contains(VEIL_CLASS)).toBe(false);
  });

  it('unhide and prune release the tracker', () => {
    const { h, t } = veiledHider();
    h.hide(unit(), 'sponsored');
    h.unhide(unit());
    expect(t.watched.size).toBe(0);
    expect(unit().className).toBe('');
    h.hide(unit(), 'sponsored');
    expect(t.watched.size).toBe(1);
    unit().remove();
    h.prune();
    expect(t.watched.size).toBe(0);
  });

  it('extract reads a veiled unit as the site built it (clip-path is invisible to the readers)', () => {
    const { h } = veiledHider();
    const u = unit();
    const label = u.querySelector('.label') as Element;
    h.hide(u, 'sponsored');
    expect(renderedWithin(label, u)).toBe(true);
    expect(renderedText(u)).toContain('Promoted');
    expect(hasContent(u)).toBe(true);
  });

  it('negative control: the same rule with visibility:hidden would blind the readers', () => {
    const { h } = veiledHider();
    const u = unit();
    const label = u.querySelector('.label') as Element;
    h.hide(u, 'sponsored');
    const style = document.createElement('style');
    style.textContent = `.${HIDDEN_CLASS}.${VEIL_CLASS} > :not([${PLACEHOLDER_ATTR}]) { visibility: hidden !important; }`;
    document.head.append(style);
    try {
      expect(renderedWithin(label, u)).toBe(false);
    } finally {
      style.remove();
    }
  });
});

// The rescan risk: a veiled unit is read again on every mutation near it. If the
// veil changed what the readers see, the unit would be released (or re-labelled)
// while still on screen. Every public fixture must hide the same set with the veil
// held on as without it, before and after a full re-decide.

const FIXTURES = join(__dirname, '../../fixtures/public');
const ALL: CategoryToggles = { sponsored: true, suggested: true, custom: true };

function hiddenSet(html: string, veil: boolean): { first: string[]; again: string[]; veiled: number } {
  const host = /<meta\s+name="sifter-host"\s+content="([^"]+)"/.exec(html)?.[1] as string;
  const url = `https://${host}${fixturePath(html)}`;
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  try {
    const doc = window.document as unknown as Document;
    doc.write(html);
    const units = Array.from(doc.querySelectorAll('*'));
    const ids = (): string[] =>
      units.flatMap((el, i) => (el.classList.contains(HIDDEN_CLASS) ? [`${i}:${el.tagName}`] : [])).sort();
    const tracker = new FakeTracker();
    const ctx = defaultContext(siteKey(host), { categories: { ...ALL } });
    const scanner = new Scanner({
      doc,
      hostname: host,
      baseUrl: url,
      adapter: adapterFor(host),
      context: ctx,
      persistOverride: () => {},
      schedule: (fn) => fn(),
      ...(veil ? { viewport: () => tracker } : {}),
    });
    scanner.scanNow();
    const first = ids();
    scanner.applyContext({ ...ctx });
    const again = ids();
    return { first, again, veiled: doc.querySelectorAll(`.${VEIL_CLASS}`).length };
  } finally {
    void window.happyDOM.close();
  }
}

describe('veiled units rescan the same', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));
  it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
  for (const file of files) {
    it(file, () => {
      const html = readFileSync(join(FIXTURES, file), 'utf8');
      const plain = hiddenSet(html, false);
      const veiled = hiddenSet(html, true);
      expect(plain.first.length, 'positive control: the fixture hides something').toBeGreaterThan(0);
      expect(veiled.veiled, 'positive control: the hides are veiled').toBe(veiled.first.length);
      expect(veiled.first).toEqual(plain.first);
      expect(veiled.again).toEqual(plain.first);
      expect(plain.again).toEqual(plain.first);
    });
  }
});
