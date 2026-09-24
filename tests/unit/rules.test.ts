import { describe, expect, it } from 'vitest';
import { fingerprint, normaliseText } from '../../src/fingerprint';
import { hasMarkerLine, isAdClickUrl, isMarkerText } from '../../src/rules/markers';
import { decideTier0 } from '../../src/rules/tier0';

describe('isMarkerText', () => {
  it.each(['Sponsored', 'Promoted', 'Ad', 'ads', ' · Promoted ', 'Gesponsord', 'Gepromoot', 'Anzeige', 'Mainos', '(Ad)', 'Sponsorisé'])(
    'accepts %j',
    (t) => expect(isMarkerText(t)).toBe(true),
  );
  it.each(['Promoted to manager', 'Advertising', 'Adobe', 'Add to your feed', 'Sponsored by nobody', '', 'Ad hoc'])(
    'rejects %j',
    (t) => expect(isMarkerText(t)).toBe(false),
  );
});

describe('hasMarkerLine', () => {
  it('finds a marker on any line', () => expect(hasMarkerLine('Northwind Cloud\nPromoted')).toBe(true));
  it('ignores words inside sentences', () => expect(hasMarkerLine('I got promoted today\nAd astra')).toBe(false));
});

describe('isAdClickUrl', () => {
  const base = 'https://www.google.com/';
  it('flags ad click hosts and /aclk paths', () => {
    expect(isAdClickUrl('https://www.googleadservices.com/pagead/aclk?x=1', base)).toBe(true);
    expect(isAdClickUrl('https://ad.doubleclick.net/ddm/clk/1', base)).toBe(true);
    expect(isAdClickUrl('/aclk?sa=l', base)).toBe(true);
  });
  it('leaves ordinary links alone', () => {
    expect(isAdClickUrl('https://example.com/aclk-guide', base)).toBe(false);
    expect(isAdClickUrl('https://news.example/aclk?x=1', base)).toBe(false);
    expect(isAdClickUrl('http://[bad', base)).toBe(false);
  });
});

describe('fingerprint', () => {
  it('is stable under whitespace changes', () => {
    expect(fingerprint('www.linkedin.com', ' Hello \n  World')).toBe(fingerprint('www.linkedin.com', 'Hello World'));
  });
  it('differs by host and by text', () => {
    const a = fingerprint('a.com', 'same text');
    expect(fingerprint('b.com', 'same text')).not.toBe(a);
    expect(fingerprint('a.com', 'other text')).not.toBe(a);
  });
  it('only looks at the first 500 normalised characters', () => {
    const head = 'x'.repeat(500);
    expect(fingerprint('a.com', head + 'tail one')).toBe(fingerprint('a.com', head + 'tail two'));
  });
  it('normalises whitespace', () => expect(normaliseText('  a \n\t b ')).toBe('a b'));
});

describe('decideTier0', () => {
  const marker = { kind: 'label' as const, category: 'sponsored' as const, detail: 'promoted' };
  const categories = { sponsored: true, suggested: false, custom: true };
  it('not-ad override beats a marker', () => expect(decideTier0({ override: 'not-ad', marker, categories }).action).toBe('show'));
  it('hide override hides as manual', () =>
    expect(decideTier0({ override: 'hide', marker: null, categories })).toMatchObject({ action: 'hide', category: 'manual' }));
  it('marker hides as sponsored', () =>
    expect(decideTier0({ override: undefined, marker, categories })).toMatchObject({ action: 'hide', category: 'sponsored' }));
  it('nothing known is unknown, not show', () => expect(decideTier0({ override: undefined, marker: null, categories }).action).toBe('unknown'));
});
