import { describe, expect, it } from 'vitest';
import { changeSignature, stableText } from '../../src/fingerprint';

// changeSignature is a one-pass rewrite of "hash stableText(text)". The reference
// below is the old two-regex version; the fast one must agree with it exactly, or a
// ticking count could start costing full decisions again (or a real change be missed).

function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function reference(text: string): string {
  const stable = stableText(text);
  return `${stable.length}:${cyrb53(stable).toString(36)}`;
}

// Seeded, so a failure reproduces.
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const ALPHABET = ['1', '2', '9', '0', '.', ',', 'a', 'K', 'h', 'r', 's', 'x', ' ', '  ', '\n', '\t', ' ', ' ', '_', 'é', '·', '#', '-'];

describe('changeSignature', () => {
  it('matches the hash of stableText on hand-picked feed strings', () => {
    const cases = [
      '',
      '   ',
      'Great post 12 likes 1.2K views 3h',
      '  Sam Doe\n\n  3h •  Edited\n 1,204 reactions ',
      '3 hrs ago',
      '3 hours ago',
      '12\n  likes',
      '5 ab_',
      '7 abc9',
      '2é',
      '10k',
      'v2.0.1 release',
      ' 12 K ',
      'ends with digit 4',
    ];
    for (const c of cases) expect(changeSignature(c), JSON.stringify(c)).toBe(reference(c));
  });

  it('matches the hash of stableText on 5000 random strings', () => {
    const r = rng(42);
    for (let n = 0; n < 5000; n++) {
      let s = '';
      const len = Math.floor(r() * 40);
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
      expect(changeSignature(s), JSON.stringify(s)).toBe(reference(s));
    }
  });

  it('negative control: a real text change moves it, a ticking count does not', () => {
    expect(changeSignature('Sam 12 likes')).toBe(changeSignature('Sam 13 likes'));
    expect(changeSignature('Sam 12 likes')).not.toBe(changeSignature('Pat 12 likes'));
  });
});
