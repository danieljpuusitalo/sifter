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
  type HiderCallbacks,
  PLACEHOLDER_ATTR,
  TAG_CLASS,
  TAG_OPEN_CLASS,
  placeholderRoot,
  unitStylesheetText,
} from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { EMPTY_LATE_STATS, type LateTracker } from '../../src/content/viewport';
import { hasContent, renderedText, renderedWithin } from '../../src/extract';
import { defaultContext } from '../../src/messages';
import { siteKey } from '../../src/storage/settings';
import type { CategoryToggles } from '../../src/types';

// The tag: a hide decided after the post was drawn never moves it. The post keeps
// its height, blurred under a zero-height "Sponsored · Hide · Show" pill, until the
// reader clicks Hide or the tracker reports it off screen below (viewport.ts). These
// tests drive a fake tracker by hand; the real one is covered end to end in
// tests/e2e/stability.spec.ts.

const noopCb: HiderCallbacks = { onShow: () => {}, onNotAd: () => {}, onRehide: () => {}, onHideTag: () => {} };

/** A tracker that never settles on its own: the test decides when a unit is far below. */
class FakeTracker implements LateTracker {
  watched = new Set<Element>();
  settle: (unit: Element) => void = () => {};
  watch(unit: Element): void {
    this.watched.add(unit);
  }
  unwatch(unit: Element): void {
    this.watched.delete(unit);
  }
  stats() {
    return { ...EMPTY_LATE_STATS };
  }
  disconnect(): void {
    this.watched.clear();
  }
  loading = false;
  loadHide(): boolean {
    return this.loading;
  }
  /** Stand-in for every watched unit ending up a screen below the reader. */
  farBelow(): void {
    for (const u of [...this.watched]) this.settle(u);
  }
}

function host(unit: Element): Element {
  const h = unit.firstElementChild;
  expect(h?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
  return h as Element;
}

function button(unit: Element, act: string): HTMLElement | null {
  return placeholderRoot(host(unit))?.querySelector(`[data-act="${act}"]`) as HTMLElement | null;
}

function label(unit: Element): string {
  return placeholderRoot(host(unit))?.querySelector('.label')?.textContent ?? '';
}

function userClick(el: HTMLElement): void {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
}

function lateHider(mode: 'collapse' | 'blur' | 'hide' = 'collapse', cb = noopCb) {
  const t = new FakeTracker();
  const h = new Hider(document, mode, cb, t);
  t.settle = (u) => h.settle(u);
  return { h, t };
}

describe('Hider tag', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul><li id="u" style="color: red"><span class="label">Promoted</span><p>An ad</p></li></ul>';
  });
  const unit = () => document.getElementById('u') as HTMLElement;

  it('a late hide lands as a blurred tag: no collapse, pill in, tracker watching, counted as hidden', () => {
    const { h, t } = lateHider();
    h.hide(unit(), 'sponsored', 'Acme');
    expect(h.isHidden(unit())).toBe(true);
    expect(h.isTagged(unit())).toBe(true);
    expect(unit().classList.contains(TAG_CLASS)).toBe(true);
    expect(unit().classList.contains(HIDDEN_CLASS)).toBe(false);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(false);
    expect(unit().style.getPropertyValue('display')).toBe('');
    expect(host(unit()).hasAttribute('data-tag')).toBe(true);
    expect(label(unit())).toBe('Sponsored');
    expect(button(unit(), 'hide-tag')?.textContent).toBe('Hide');
    expect(button(unit(), 'show')?.textContent).toBe('Show');
    expect(button(unit(), 'not-ad')?.textContent).toBe('Not an ad');
    expect(t.watched.has(unit())).toBe(true);
    // The reader can't read it, so the popup counts it.
    expect(h.hiddenUnits()).toEqual([unit()]);
    expect(h.trackedHides()).toEqual([unit()]);
  });

  it('Show on a tag unblurs it in place; it stays put, drops out of the count, and the tracker lets go', () => {
    const { h, t } = lateHider();
    h.hide(unit(), 'sponsored');
    h.show(unit());
    expect(h.isTagged(unit()), 'still a tag: same height, pill kept').toBe(true);
    expect(unit().classList.contains(TAG_OPEN_CLASS)).toBe(true);
    expect(host(unit()).hasAttribute('data-tag')).toBe(true);
    expect(button(unit(), 'hide-tag')).not.toBeNull();
    expect(button(unit(), 'show')).toBeNull();
    expect(h.hiddenUnits()).toEqual([]);
    expect(t.watched.size, 'never collapsed under a reader who chose to read it').toBe(0);
    h.rehide(unit());
    expect(unit().classList.contains(TAG_OPEN_CLASS), 'rehide blurs again').toBe(false);
    expect(h.hiddenUnits()).toEqual([unit()]);
    expect(t.watched.size).toBe(1);
    h.show(unit());
    h.settle(unit());
    expect(unit().classList.contains(COLLAPSE_CLASS), 'Hide on an opened tag collapses it').toBe(true);
    expect(unit().classList.contains(TAG_OPEN_CLASS)).toBe(false);
    expect(h.hiddenUnits()).toEqual([unit()]);
    expect(button(unit(), 'show')).not.toBeNull();
  });

  // Google, 2026-10-01: nobody is reading yet at load, so a collapse moves nothing they see.
  it('while the tracker says the page is loading, a hide collapses at once', () => {
    const { h, t } = lateHider();
    t.loading = true;
    h.hide(unit(), 'sponsored');
    expect(h.isTagged(unit())).toBe(false);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(h.hiddenUnits()).toEqual([unit()]);
    expect(t.watched.size).toBe(0);
  });

  it('now: the pre-paint lane and a hide the reader asked for skip the tag', () => {
    const { h, t } = lateHider();
    h.hide(unit(), 'sponsored', undefined, true);
    expect(h.isTagged(unit())).toBe(false);
    expect(unit().classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(t.watched.size).toBe(0);
  });

  it('now on an existing tag settles it (the context menu on a tagged post)', () => {
    const { h, t } = lateHider();
    h.hide(unit(), 'sponsored');
    h.hide(unit(), 'manual', undefined, true);
    expect(h.isTagged(unit())).toBe(false);
    expect(h.categoryOf(unit())).toBe('manual');
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(t.watched.size).toBe(0);
  });

  it('blur mode never tags: blur changes no layout, so it applies at once', () => {
    const { h, t } = lateHider('blur');
    h.hide(unit(), 'sponsored');
    expect(h.isTagged(unit())).toBe(false);
    expect(unit().classList.contains(BLUR_CLASS)).toBe(true);
    expect(t.watched.size).toBe(0);
  });

  it('the tag CSS places the placeholder at zero height and blurs the content, changing no layout', () => {
    const { h } = lateHider();
    h.hide(unit(), 'sponsored');
    const css = unitStylesheetText(document);
    const tagRules = css.split('\n').filter((l) => l.includes(TAG_CLASS));
    expect(tagRules.length, 'positive control: tag rules exist').toBe(2);
    const place = tagRules.find((r) => r.includes(`.${TAG_CLASS} > [${PLACEHOLDER_ATTR}]`));
    expect(place).toMatch(/height: 0(px)? !important/);
    const blur = tagRules.find((r) => r !== place) as string;
    expect(blur).toContain(`.${TAG_CLASS}:not(.${TAG_OPEN_CLASS}) > :not([${PLACEHOLDER_ATTR}])`);
    // Paint-only properties: no display, height, margin, padding or position.
    const decl = /\{([^}]*)\}/.exec(blur)?.[1] ?? '';
    const props = decl.split(';').map((d) => d.split(':')[0]!.trim()).filter(Boolean).sort();
    expect(props).toEqual(['filter', 'pointer-events']);
    // The pill overflows its zero-height host instead of pushing the post down.
    const shadowCss = Array.from(placeholderRoot(host(unit()))?.adoptedStyleSheets ?? [])
      .flatMap((s) => Array.from(s.cssRules).map((r) => r.cssText))
      .join('\n');
    expect(shadowCss).toMatch(/:host\(\[data-tag\]\) \.row \{[^}]*position: absolute/);
  });

  it('settle collapses into the real mode, the bar says what it hid, and stops watching', () => {
    const { h, t } = lateHider();
    h.hide(unit(), 'sponsored', 'Acme');
    t.farBelow();
    expect(h.isTagged(unit())).toBe(false);
    expect(unit().classList.contains(TAG_CLASS)).toBe(false);
    expect(unit().classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(unit().classList.contains(COLLAPSE_CLASS)).toBe(true);
    expect(host(unit()).hasAttribute('data-tag')).toBe(false);
    expect(label(unit())).toBe('Hidden sponsored post · Acme');
    expect(button(unit(), 'show')).not.toBeNull();
    expect(h.hiddenUnits()).toEqual([unit()]);
    expect(t.watched.size).toBe(0);
    h.settle(unit());
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`).length).toBe(1);
  });

  it('hide mode: the tag has a pill, settle drops it for display:none, and unhide restores the style', () => {
    const { h, t } = lateHider('hide');
    h.hide(unit(), 'sponsored');
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`).length).toBe(1);
    expect(unit().style.getPropertyValue('display')).toBe('');
    t.farBelow();
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    expect(unit().style.getPropertyValue('display')).toBe('none');
    h.unhide(unit());
    expect(unit().style.getPropertyValue('display')).toBe('');
    expect(unit().style.getPropertyValue('color')).toBe('red');
  });

  it('Hide on the pill asks the scanner; untrusted clicks do nothing', () => {
    const asked: Element[] = [];
    const { h } = lateHider('collapse', { ...noopCb, onHideTag: (u) => void asked.push(u) });
    h.hide(unit(), 'sponsored');
    const b = button(unit(), 'hide-tag') as HTMLElement;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(asked).toEqual([]);
    userClick(b);
    expect(asked).toEqual([unit()]);
  });

  it('setMode keeps a tag a tag, except blur, which settles it', () => {
    const { h, t } = lateHider('collapse');
    h.hide(unit(), 'sponsored');
    h.setMode('hide');
    expect(h.isTagged(unit())).toBe(true);
    expect(unit().style.getPropertyValue('display')).toBe('');
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`).length).toBe(1);
    h.setMode('blur');
    expect(h.isTagged(unit())).toBe(false);
    expect(unit().classList.contains(BLUR_CLASS)).toBe(true);
    expect(t.watched.size).toBe(0);
    h.unhide(unit());
    expect(unit().className).toBe('');
    expect(unit().getAttribute('style')).toBe('color: red');
  });

  it('unhide and prune release the tracker and the class', () => {
    const { h, t } = lateHider();
    h.hide(unit(), 'sponsored');
    h.unhide(unit());
    expect(t.watched.size).toBe(0);
    expect(unit().className).toBe('');
    expect(document.querySelector(`[${PLACEHOLDER_ATTR}]`)).toBeNull();
    h.hide(unit(), 'sponsored');
    expect(t.watched.size).toBe(1);
    unit().remove();
    h.prune();
    expect(t.watched.size).toBe(0);
  });

  it('extract reads a tagged unit as the site built it', () => {
    const { h } = lateHider();
    const u = unit();
    const lbl = u.querySelector('.label') as Element;
    h.hide(u, 'sponsored');
    expect(renderedWithin(lbl, u)).toBe(true);
    expect(renderedText(u)).toContain('Promoted');
    expect(hasContent(u)).toBe(true);
  });
});

// The rescan risk: a tagged unit is read again on every mutation near it. If the
// tag changed what the readers see, the unit would be released (or re-labelled)
// while still on screen. Every public fixture must catch the same set with tags as
// without them, before and after a full re-decide.

const FIXTURES = join(__dirname, '../../fixtures/public');
const ALL: CategoryToggles = { sponsored: true, suggested: true, custom: true };

function caughtSet(html: string, late: boolean): { first: string[]; again: string[]; tagged: number } {
  const hostName = /<meta\s+name="sifter-host"\s+content="([^"]+)"/.exec(html)?.[1] as string;
  const url = `https://${hostName}${fixturePath(html)}`;
  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  try {
    const doc = window.document as unknown as Document;
    doc.write(html);
    const units = Array.from(doc.querySelectorAll('*'));
    const ids = (): string[] =>
      units.flatMap((el, i) => (el.classList.contains(HIDDEN_CLASS) || el.classList.contains(TAG_CLASS) ? [`${i}:${el.tagName}`] : [])).sort();
    const tracker = new FakeTracker();
    const ctx = defaultContext(siteKey(hostName), { categories: { ...ALL } });
    const scanner = new Scanner({
      doc,
      hostname: hostName,
      baseUrl: url,
      adapter: adapterFor(hostName),
      context: ctx,
      persistOverride: () => {},
      schedule: (fn) => fn(),
      ...(late ? { viewport: () => tracker } : {}),
    });
    scanner.scanNow();
    const first = ids();
    scanner.applyContext({ ...ctx });
    const again = ids();
    return { first, again, tagged: doc.querySelectorAll(`.${TAG_CLASS}`).length };
  } finally {
    void window.happyDOM.close();
  }
}

describe('tagged units rescan the same', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));
  it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
  for (const file of files) {
    it(file, () => {
      const html = readFileSync(join(FIXTURES, file), 'utf8');
      const plain = caughtSet(html, false);
      const tagged = caughtSet(html, true);
      expect(plain.first.length, 'positive control: the fixture hides something').toBeGreaterThan(0);
      expect(tagged.tagged, 'positive control: the hides are tags').toBe(tagged.first.length);
      expect(tagged.first).toEqual(plain.first);
      expect(tagged.again).toEqual(plain.first);
      expect(plain.again).toEqual(plain.first);
    });
  }
});
