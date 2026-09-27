import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { COLLAPSE_CLASS, HIDDEN_CLASS, PLACEHOLDER_ATTR } from '../../src/content/hider';
import { positionalSelectors, Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

// A rescan of a unit Sifter already collapsed used to lift the hide classes for
// the read, which un-hid the whole post for one getComputedStyle: a style recalc
// and a forced layout of the post, then the same again when the classes went
// back (9-10 ms per rescan on live LinkedIn, bench/live.ts). The reads now
// discount our own collapse instead, and must still honour the site's own hiding.

const HOST = 'www.linkedin.com';
const unit = (label: string) =>
  `<div role="listitem" componentkey="update-card-focus-1" id="u1">` +
  `<div class="head"><p componentkey="h" id="p1"><span>${label}</span></p></div>` +
  `<div class="body" id="body">Great deals on shoes this week only</div>` +
  `</div>`;

function setup() {
  document.body.innerHTML = unit('Promoted');
  const scanner = new Scanner({
    doc: document,
    hostname: HOST,
    baseUrl: `https://${HOST}/`,
    adapter: adapterFor(HOST),
    context: defaultContext('linkedin.com'),
    persistOverride: () => {},
    schedule: (fn) => fn(),
  });
  scanner.scanNow();
  return { scanner, u1: document.getElementById('u1')! };
}

describe('rescan of a unit Sifter collapsed reads it without un-hiding it', () => {
  it('positive control: the unit is collapsed by the first scan', () => {
    const { u1 } = setup();
    expect(u1.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(u1.classList.contains(COLLAPSE_CLASS)).toBe(true);
    // And the collapse really hides the children as far as computed style goes,
    // or the tests below would pass without the discount doing anything.
    expect(getComputedStyle(document.getElementById('body')!).display).toBe('none');
  });

  it('a changed hidden unit is re-decided, stays hidden, and its classes never move', () => {
    const { scanner, u1 } = setup();
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((rs) => records.push(...rs));
    mo.observe(u1, { attributes: true, attributeFilter: ['class'], childList: true });
    const before = scanner.state().perf.unitsDecided;
    document.getElementById('body')!.textContent = 'Great deals on boots this week only';
    scanner.applyContext(defaultContext('linkedin.com'));
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(scanner.state().perf.unitsDecided, 'positive control: decide ran').toBeGreaterThan(before);
    expect(u1.classList.contains(HIDDEN_CLASS)).toBe(true);
    expect(records.filter((r) => r.type === 'attributes')).toEqual([]);
    // LinkedIn's selectors don't count siblings, so the placeholder stays put too.
    expect(records.filter((r) => r.type === 'childList')).toEqual([]);
    expect(u1.firstElementChild?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
  });

  it("the site's own hiding below the unit's children still counts: a hidden label releases the unit", () => {
    const { scanner, u1 } = setup();
    // A recycled node: the "Promoted" label is now display:none by the site itself.
    document.getElementById('p1')!.style.display = 'none';
    document.getElementById('body')!.textContent = 'A real post about a new job';
    scanner.applyContext(defaultContext('linkedin.com'));
    expect(u1.classList.contains(HIDDEN_CLASS)).toBe(false);
  });
});

describe('positionalSelectors', () => {
  it('is true only for adapters whose in-unit selectors count siblings', () => {
    expect(positionalSelectors(adapterFor('www.threads.com'))).toBe(true);
    for (const host of ['www.linkedin.com', 'www.facebook.com', 'x.com', 'www.reddit.com', 'www.instagram.com']) {
      expect(positionalSelectors(adapterFor(host)), host).toBe(false);
    }
    expect(positionalSelectors(null)).toBe(false);
  });
});
