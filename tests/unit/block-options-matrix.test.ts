import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Adapter } from '../../src/adapters/schema';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS, PLACEHOLDER_ATTR } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext, type SiteContext } from '../../src/messages';
import { siteKey } from '../../src/storage/settings';

// Exhaustive on/off matrix for every "Block on this site" option, on every site
// adapter that has a fixture, through the real scanner pipeline. This is generic
// on purpose: it never hardcodes which unit is which. Instead it leans on two
// facts every fixture already gives us:
//  - `[data-gold]` sits on exactly the element the scanner hides (the unit root,
//    or the whole module for a block rule), so classList.contains(HIDDEN_CLASS)
//    on that same node tells us the outcome.
//  - a live `Scanner.applyContext` mutates the same DOM in place, so a unit's
//    identity (the Element reference) survives across context changes and lets
//    a test compare hidden-before vs hidden-after directly, with no need to
//    guess which post is which by content.

const ALL_ON = { sponsored: true, suggested: true, custom: true };

type SiteFixture = { id: string; fixture: string; host: string };

const SITES: SiteFixture[] = [
  { id: 'linkedin', fixture: 'linkedin-feed.html', host: 'www.linkedin.com' },
  { id: 'facebook', fixture: 'facebook-feed.html', host: 'www.facebook.com' },
  { id: 'instagram', fixture: 'instagram-feed.html', host: 'www.instagram.com' },
  { id: 'x', fixture: 'x-home.html', host: 'x.com' },
  { id: 'reddit', fixture: 'reddit-home.html', host: 'www.reddit.com' },
  { id: 'threads', fixture: 'threads-feed.html', host: 'www.threads.com' },
  { id: 'google-search', fixture: 'google-search.html', host: 'www.google.com' },
  { id: 'google-ad-containers', fixture: 'google-ad-containers.html', host: 'www.google.com' },
];

/** Fixtures that carry `data-gold="suggested"` units; the others prove only the sponsored path. */
const SITES_WITH_SUGGESTED = new Set(['linkedin', 'facebook', 'instagram', 'x']);

// Includes `<head>` (not just `<body>`): some fixtures use a CSS-hidden decoy
// (e.g. a `display:none` "Promoted" span) to prove the scanner's visibility-aware
// text extraction ignores it, which only works if the `<style>` rule is actually
// loaded — happy-dom's getComputedStyle sees nothing otherwise.
function loadFixture(fixture: string): string {
  const html = readFileSync(`fixtures/public/${fixture}`, 'utf8');
  const inner = html.slice(html.indexOf('<html'), html.lastIndexOf('</html>'));
  return inner.slice(inner.indexOf('>') + 1);
}

function mkContext(host: string, over: Partial<SiteContext> = {}): SiteContext {
  return defaultContext(siteKey(host), { categories: ALL_ON, ...over });
}

/** Parses the fixture fresh into `document.body` and starts a live scanner over it, all rules and categories on unless `over` says otherwise. */
function scan(fixture: string, host: string, over: Partial<SiteContext> = {}): Scanner {
  document.documentElement.innerHTML = loadFixture(fixture);
  const s = new Scanner({
    doc: document,
    hostname: host,
    baseUrl: `https://${host}/`,
    adapter: adapterFor(host),
    context: mkContext(host, over),
    persistOverride: () => undefined,
    schedule: (fn) => fn(),
  });
  s.scanNow();
  return s;
}

function apply(s: Scanner, host: string, over: Partial<SiteContext> = {}): void {
  s.applyContext(mkContext(host, over));
  s.scanNow();
}

const goldEls = (gold?: string): Element[] => [...document.querySelectorAll(gold ? `[data-gold="${gold}"]` : '[data-gold]')];
const isHidden = (el: Element): boolean => el.classList.contains(HIDDEN_CLASS);

/** The placeholder's label text (shadow DOM), or null when the unit carries no placeholder. */
function placeholderText(unit: Element): string | null {
  const ph = unit.firstElementChild as HTMLElement | null;
  if (!ph || !ph.hasAttribute(PLACEHOLDER_ATTR)) return null;
  return ph.shadowRoot?.querySelector('.label')?.textContent ?? null;
}

/** Every rule id the user can switch off on this site: named suggested rules, plus any block's own rule id. */
function ruleIds(adapter: Adapter): string[] {
  const ids = new Set<string>();
  for (const r of adapter.suggested?.rules ?? []) ids.add(r.id);
  for (const b of adapter.blocks) if (b.rule) ids.add(b.rule);
  return [...ids];
}

function ruleLabel(adapter: Adapter, id: string): string {
  const label = adapter.suggested?.rules.find((r) => r.id === id)?.label;
  if (!label) throw new Error(`no label for rule "${id}" on ${adapter.id}`);
  return label;
}

describe.each(SITES)('$id: categories', ({ id, fixture, host }) => {
  it(`${id}: positive control — all categories on hides something, and only sponsored or suggested gold`, () => {
    scan(fixture, host);
    const hidden = goldEls().filter(isHidden);
    expect(hidden.length, `${id}: nothing was hidden with every category on`).toBeGreaterThan(0);
    for (const el of hidden) {
      const gold = el.getAttribute('data-gold');
      expect(['sponsored', 'suggested'], `${id}: hid a unit whose gold is "${gold}"`).toContain(gold);
    }
  });

  it(`${id}: sponsored off keeps suggested hidden and releases every sponsored unit; suggested off is the mirror; both off hides nothing`, () => {
    const s = scan(fixture, host);
    const all = goldEls();
    const hAll = new Set(all.filter(isHidden));
    expect(hAll.size, `${id}: nothing hidden to test against`).toBeGreaterThan(0);
    // The "keeps the other category hidden" half of this test only says something
    // where the fixture has both kinds of unit hidden. Reddit, Threads and Google
    // carry no suggested gold, so state that here rather than pass on an empty loop.
    const hasSuggested = [...hAll].some((el) => el.getAttribute('data-gold') === 'suggested');
    const hasSponsored = [...hAll].some((el) => el.getAttribute('data-gold') === 'sponsored');
    expect(hasSponsored, `${id}: no sponsored unit hidden at baseline`).toBe(true);
    expect(hasSuggested, `${id}: suggested gold present in the fixture`).toBe(SITES_WITH_SUGGESTED.has(id));

    apply(s, host, { categories: { sponsored: false, suggested: true, custom: true } });
    for (const el of all) if (el.getAttribute('data-gold') === 'sponsored') expect(isHidden(el), `${id}: sponsored unit still hidden with sponsored off`).toBe(false);
    for (const el of hAll) if (el.getAttribute('data-gold') === 'suggested') expect(isHidden(el), `${id}: suggested unit released when only sponsored went off`).toBe(true);

    apply(s, host, { categories: { sponsored: true, suggested: false, custom: true } });
    for (const el of all) if (el.getAttribute('data-gold') === 'suggested') expect(isHidden(el), `${id}: suggested unit still hidden with suggested off`).toBe(false);
    for (const el of hAll) if (el.getAttribute('data-gold') === 'sponsored') expect(isHidden(el), `${id}: sponsored unit released when only suggested went off`).toBe(true);

    apply(s, host, { categories: { sponsored: false, suggested: false, custom: true } });
    for (const el of all) expect(isHidden(el), `${id}: something stayed hidden with both categories off`).toBe(false);
  });

  it(`${id}: category switches toggle live on one scanner, and disabling/enabling the whole site unhides/rehides everything`, () => {
    const s = scan(fixture, host);
    const all = goldEls();
    const hAll = new Set(all.filter(isHidden));
    expect(hAll.size, `${id}: nothing hidden to test against`).toBeGreaterThan(0);

    apply(s, host, { categories: { sponsored: false, suggested: true, custom: true } });
    for (const el of all) if (el.getAttribute('data-gold') === 'sponsored') expect(isHidden(el), `${id}: sponsored not shown when switched off`).toBe(false);
    apply(s, host);
    for (const el of hAll) expect(isHidden(el), `${id}: unit did not come back after switching sponsored back on`).toBe(true);

    apply(s, host, { categories: { sponsored: true, suggested: false, custom: true } });
    for (const el of all) if (el.getAttribute('data-gold') === 'suggested') expect(isHidden(el), `${id}: suggested not shown when switched off`).toBe(false);
    apply(s, host);
    for (const el of hAll) expect(isHidden(el), `${id}: unit did not come back after switching suggested back on`).toBe(true);

    apply(s, host, { enabled: false });
    for (const el of all) expect(isHidden(el), `${id}: unit still hidden with the site disabled`).toBe(false);
    apply(s, host, { enabled: true });
    for (const el of hAll) expect(isHidden(el), `${id}: unit did not come back after re-enabling the site`).toBe(true);
  });
});

describe.each(SITES)('$id: named suggested rules', ({ id, fixture, host }) => {
  const adapter = adapterFor(host);
  const rules = adapter ? ruleIds(adapter) : [];

  if (!adapter) {
    it.skip(`${id}: no adapter matches this host`, () => undefined);
    return;
  }
  if (rules.length === 0) {
    it.skip(`${id}: adapter "${adapter.id}" has no named suggested rules and no block carries a rule id`, () => undefined);
    return;
  }

  it.each(rules)(`${id}: rule "%s" off releases a strict, real subset, toggles live, and its label was on the placeholder`, (ruleId) => {
    const s = scan(fixture, host);
    const all = goldEls();
    const hAll = new Set(all.filter(isHidden));
    expect(hAll.size, `${id}/${ruleId}: nothing hidden to test against`).toBeGreaterThan(0);
    const labelsWhenOn = new Map(all.map((el) => [el, placeholderText(el)] as const));

    apply(s, host, { offRules: [ruleId] });
    const hiddenAfter = new Set(all.filter(isHidden));

    // nothing outside H_all is hidden
    for (const el of hiddenAfter) expect(hAll.has(el), `${id}/${ruleId}: hid a unit outside H_all`).toBe(true);
    // strict subset: the rule released at least one unit (a dead rule fails here)
    expect(hiddenAfter.size, `${id}/${ruleId}: turning the rule off released nothing (dead rule)`).toBeLessThan(hAll.size);

    const released = [...hAll].filter((el) => !hiddenAfter.has(el));
    expect(released.length, `${id}/${ruleId}: no units released`).toBeGreaterThan(0);
    for (const el of released) {
      expect(el.getAttribute('data-gold'), `${id}/${ruleId}: released a unit that was not gold="suggested"`).toBe('suggested');
      // no other active rule matched this unit, since turning off only this rule released it
      const label = ruleLabel(adapter, ruleId);
      expect(labelsWhenOn.get(el), `${id}/${ruleId}: placeholder did not name this rule while it was the only match`).toBe(`Hidden suggestion · ${label}`);
      expect(isHidden(el), `${id}/${ruleId}: released unit still carries ${HIDDEN_CLASS}`).toBe(false);
      const ph = el.firstElementChild;
      expect(!ph || !ph.hasAttribute(PLACEHOLDER_ATTR), `${id}/${ruleId}: released unit still carries a placeholder`).toBe(true);
    }
    // everything else in H_all is still hidden
    for (const el of hAll) if (!released.includes(el)) expect(isHidden(el), `${id}/${ruleId}: an unrelated hidden unit was released`).toBe(true);

    // toggle back on: the released units are hidden again
    apply(s, host);
    for (const el of released) expect(isHidden(el), `${id}/${ruleId}: unit did not re-hide when the rule was switched back on`).toBe(true);
  });

  it(`${id}: all rules off releases every suggested-gold unit and leaves every sponsored-gold unit hidden, never re-hiding what a single rule already released`, () => {
    const s = scan(fixture, host);
    const all = goldEls();
    const hAll = new Set(all.filter(isHidden));
    expect(hAll.size, `${id}: nothing hidden to test against`).toBeGreaterThan(0);

    // A unit can match more than one rule at once (e.g. LinkedIn's "activity" and
    // "follow" both fire on the same social line + Follow button), so it only
    // releases once every rule matching it is off, not when any one is off. The
    // union of single-rule releases is therefore a lower bound, not the exact
    // set — assert it monotonically, and assert the exact outcome by gold label.
    const unionReleased = new Set<Element>();
    for (const ruleId of rules) {
      apply(s, host, { offRules: [ruleId] });
      for (const el of hAll) if (!isHidden(el)) unionReleased.add(el);
      apply(s, host); // reset to every rule on before testing the next one
    }

    apply(s, host, { offRules: rules });
    const hiddenAllOff = new Set(all.filter(isHidden));
    for (const el of unionReleased) {
      expect(hiddenAllOff.has(el), `${id}: a unit some single rule already released came back hidden with every rule off`).toBe(false);
    }
    for (const el of hAll) {
      const gold = el.getAttribute('data-gold');
      if (gold === 'suggested') expect(hiddenAllOff.has(el), `${id}: a suggested unit stayed hidden with every named rule off`).toBe(false);
      else expect(hiddenAllOff.has(el), `${id}: a ${gold} unit was released by turning every suggested rule off`).toBe(true);
    }
  });
});

describe('linkedin: custom filters (muted words and element rules)', () => {
  const fixture = 'linkedin-feed.html';
  const host = 'www.linkedin.com';
  // A data-gold="none" unit (Aino Virtanen's post) with a word that appears nowhere else in the fixture.
  const wordUnitSelector = '[componentkey="update-card-focus1001FeedType_MAIN_FEED_RELEVANCE"]';
  const mutedWord = 'copywriting';
  // A different data-gold="none" unit (Mika Laine's post), matched by its own componentkey.
  const selectorUnitSelector = '[componentkey="update-card-focus1008FeedType_MAIN_FEED_RELEVANCE"]';

  it('a muted word hides only the unit containing it, with a placeholder naming the word, and toggles live', () => {
    const s = scan(fixture, host, { mutedWords: [mutedWord] });
    const unit = document.querySelector(wordUnitSelector)!;
    expect(unit.getAttribute('data-gold')).toBe('none');
    expect(isHidden(unit), 'muted-word unit not hidden with custom on').toBe(true);
    expect(placeholderText(unit)).toContain(`muted word “${mutedWord}”`);

    apply(s, host, { categories: { sponsored: true, suggested: true, custom: false }, mutedWords: [mutedWord] });
    expect(isHidden(unit), 'muted-word unit still hidden with custom off').toBe(false);

    apply(s, host, { mutedWords: [mutedWord] });
    expect(isHidden(unit), 'muted-word unit did not re-hide when custom went back on').toBe(true);
  });

  it('an element rule hides only the matched unit, with a placeholder naming the rule, and toggles live', () => {
    const s = scan(fixture, host, { customSelectors: [selectorUnitSelector] });
    const unit = document.querySelector(selectorUnitSelector)!;
    expect(unit.getAttribute('data-gold')).toBe('none');
    expect(isHidden(unit), 'element-rule unit not hidden with custom on').toBe(true);
    // The hint is `rule ${selector}` capped at 60 chars (scanner.ts's MAX_HINT), so a
    // selector this long comes back truncated — assert the same truncation, not the
    // full selector.
    expect(placeholderText(unit)).toBe(`Hidden by your filter · ${`rule ${selectorUnitSelector}`.slice(0, 60)}`);

    apply(s, host, { categories: { sponsored: true, suggested: true, custom: false }, customSelectors: [selectorUnitSelector] });
    expect(isHidden(unit), 'element-rule unit still hidden with custom off').toBe(false);

    apply(s, host, { customSelectors: [selectorUnitSelector] });
    expect(isHidden(unit), 'element-rule unit did not re-hide when custom went back on').toBe(true);
  });
});
