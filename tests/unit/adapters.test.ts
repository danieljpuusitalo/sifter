import { describe, expect, it } from 'vitest';
import { findGenericUnits, innermost } from '../../src/adapters/generic';
import { ADAPTERS, RAW_ADAPTERS, adapterFor, withDefaults } from '../../src/adapters/index';
import { AdapterSchema } from '../../src/adapters/schema';
import { allSelectors } from '../../src/adapters/selectors';
import { GOOGLE_DOMAINS, LAUNCH_MATCHES } from '../../src/sites';

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body;
}

/**
 * Adapters known to rest on a single sponsored signal today, with why that's an
 * accepted trade rather than an oversight. A NEW adapter, or a signal removed
 * from an existing one, must fail this test unless someone edits this list on
 * purpose: that's the point (see tests/e2e/selector-canary.spec.ts for the
 * matching real-Chromium check on every selector these adapters carry).
 */
const SINGLE_SIGNAL_ADAPTERS: Record<string, string> = {
  linkedin: "single signal: 'Promoted' is plain label text only (verified 2026-09-24); no structural ad marker exists on this site.",
  reddit: 'single signal: shreddit-ad-post is the only sponsored marker seen; the browser tool is blocked on reddit.com so a second one has not been found.',
  google: 'structural-only by design: ad containers carry no Sponsored label text in the DOM, detection is the #tads/#atvcap/plap_ selector family.',
  x: "single signal: only the placementTracking wrapper marks a promoted tweet; X's own visible 'Ad' text is deliberately not read as a label (verified note).",
  instagram: 'single signal: only the facebook.com/ads/ig_redirect link marks a sponsored article; no stable Sponsored label element exists.',
};

/** The four independent ways an adapter can carry sponsored evidence (BRIEF.md §5). */
function sponsoredSignalCount(a: (typeof ADAPTERS)[number]): number {
  let n = 0;
  if (a.adSelectors.length > 0) n++; // structural: a dedicated ad element/attribute
  if (a.labelSelectors.length > 0) n++; // a header node checked against the marker-word list
  if (a.blocks.some((b) => b.category === 'sponsored')) n++; // a whole module hidden by rule
  // The rel=sponsored / ad-click check (extract.ts) runs globally for every
  // adapter already, so it is not counted here: it can't distinguish one
  // adapter's coverage from another's.
  return n;
}

describe('adapters', () => {
  it('all parse and have valid selectors', () => {
    for (const a of ADAPTERS) {
      for (const sel of allSelectors(a)) {
        expect(() => document.querySelectorAll(sel), `${a.id}: ${sel}`).not.toThrow();
      }
    }
  });

  it('every adapter has at least two independent sponsored signals, or is on the allowlist', () => {
    for (const a of ADAPTERS) {
      const count = sponsoredSignalCount(a);
      if (a.id in SINGLE_SIGNAL_ADAPTERS) {
        expect(count, `${a.id} is allowlisted as single-signal but now has ${count}: update SINGLE_SIGNAL_ADAPTERS`).toBeLessThan(2);
      } else {
        expect(count, `${a.id} has only ${count} sponsored signal(s); add a second one or allowlist it in SINGLE_SIGNAL_ADAPTERS with a reason`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('every shipped adapter passes the schema, and withDefaults matches what the schema would produce', () => {
    // The content script skips zod (bundle size, parse at load), so the hand-written
    // defaults must never drift from schema.ts.
    for (const raw of RAW_ADAPTERS) {
      const parsed = AdapterSchema.parse(raw);
      expect(withDefaults(raw), parsed.id).toEqual(parsed);
    }
  });

  it('a block anchor is one cheap compound selector', () => {
    // The anchor is what the scanner looks for in a dirty subtree; the scope and
    // the `:has()` live in the selector it then climbs to. An ancestor part in the
    // anchor would be invisible to a query scoped to an added subtree in happy-dom.
    for (const a of ADAPTERS) {
      for (const b of a.blocks) {
        if (!b.anchor) continue;
        expect(b.anchor, `${a.id}: anchor must not use :has()`).not.toContain(':has(');
        expect(b.anchor, `${a.id}: anchor must be a single compound selector`).not.toMatch(/[\s>+~,]/);
      }
    }
  });

  it('google hosts match the manifest domains', () => {
    const google = ADAPTERS.find((a) => a.id === 'google');
    expect(google?.hosts.slice().sort()).toEqual(GOOGLE_DOMAINS.slice().sort());
    for (const d of GOOGLE_DOMAINS) expect(LAUNCH_MATCHES).toContain(`https://www.${d}/*`);
  });

  it('adapterFor matches exact host and subdomains only', () => {
    expect(adapterFor('www.linkedin.com')?.id).toBe('linkedin');
    expect(adapterFor('www.google.co.uk')?.id).toBe('google');
    expect(adapterFor('reddit.com')?.id).toBe('reddit');
    expect(adapterFor('notreddit.com')).toBeNull();
    expect(adapterFor('google.com.evil.example')).toBeNull();
  });
});

describe('innermost', () => {
  it('drops units that contain other units', () => {
    const body = html('<div id="o"><div id="a"></div><div id="b"></div></div><div id="c"></div>');
    const ids = innermost(body.querySelectorAll('div')).map((e) => e.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('findGenericUnits', () => {
  const card = (i: number) =>
    `<article class="card"><h2>Story ${i}</h2><p>Some body text that is long enough to count as a real unit of content, number ${i}.</p></article>`;

  it('finds repeated sibling cards', () => {
    const body = html(`<main>${[1, 2, 3, 4, 5].map(card).join('')}</main>`);
    expect(findGenericUnits(body)).toHaveLength(5);
  });

  it('needs at least four of a kind', () => {
    const body = html(`<main>${[1, 2, 3].map(card).join('')}</main>`);
    expect(findGenericUnits(body)).toHaveLength(0);
  });

  it('skips navigation chrome and short items', () => {
    const body = html(
      `<nav>${[1, 2, 3, 4].map(card).join('')}</nav><ul>${'<li class="x">tiny</li>'.repeat(6)}</ul>`,
    );
    expect(findGenericUnits(body)).toHaveLength(0);
  });
});
