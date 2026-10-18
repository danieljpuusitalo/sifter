import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Chrome refuses to load an extension whose content script holds a Unicode
// noncharacter (U+FFFE, U+FFFF, U+FDD0..U+FDEF): "It isn't UTF-8 encoded", and
// then not even the service worker starts. A range like [\u0080-￿] written
// with a raw character, or minified from an escape, puts one in the bundle.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|json)$/.test(name) ? [p] : [];
  });
}

describe('source encoding', () => {
  it('holds no Unicode noncharacter in src/ or entrypoints/', () => {
    const bad: string[] = [];
    for (const p of [...files('src'), ...files('entrypoints')]) {
      for (const ch of readFileSync(p, 'utf8')) {
        const c = ch.codePointAt(0)!;
        if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) bad.push(`${p} U+${c.toString(16)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
