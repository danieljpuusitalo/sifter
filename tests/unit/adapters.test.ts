import { describe, expect, it } from 'vitest';
import { findGenericUnits, innermost } from '../../src/adapters/generic';
import { ADAPTERS, RAW_ADAPTERS, adapterFor, withDefaults } from '../../src/adapters/index';
import { AdapterSchema } from '../../src/adapters/schema';
import { GOOGLE_DOMAINS, LAUNCH_MATCHES } from '../../src/sites';

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body;
}

describe('adapters', () => {
  it('all parse and have valid selectors', () => {
    for (const a of ADAPTERS) {
      for (const sel of [a.unitSelector, ...a.labelSelectors, ...a.adSelectors, ...a.blocks.flatMap((b) => [b.selector, ...(b.anchor ? [b.anchor] : [])])]) {
        expect(() => document.querySelectorAll(sel), `${a.id}: ${sel}`).not.toThrow();
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
