import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS, PLACEHOLDER_ATTR } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import * as extract from '../../src/extract';
import { defaultContext } from '../../src/messages';

// Sifter's placeholder is the hidden unit's first child. A selector that counts
// children ("> div:first-child span", Threads' header) then stops matching the
// header on a rescan, so the unit read as "no marker" and was released, then
// hidden again on the scan after that: it flapped on every popup toggle. The
// read in decide() must see the unit as it was before Sifter touched it.

const ON = { sponsored: true, suggested: true, custom: true };

function load(fixture: string) {
  const html = readFileSync(`fixtures/public/${fixture}`, 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/^<body[^>]*>/, '');
}
const hiddenGold = () =>
  [...document.querySelectorAll('[data-gold="sponsored"]')].map((el) => el.classList.contains(HIDDEN_CLASS));

describe('rescan of a hidden unit whose label selector counts children', () => {
  it('Threads: both sponsored posts stay hidden across repeated rescans', () => {
    load('threads-feed.html');
    const host = 'www.threads.com';
    const ctx = () => defaultContext('threads.com', { categories: ON });
    const s = new Scanner({
      doc: document,
      hostname: host,
      baseUrl: `https://${host}/`,
      adapter: adapterFor(host),
      context: ctx(),
      persistOverride: () => undefined,
      schedule: (fn) => fn(),
    });
    s.scanNow();
    expect(hiddenGold(), 'positive control: first scan').toEqual([true, true]);
    // The placeholder is in place, first child of each hidden unit.
    for (const el of document.querySelectorAll('[data-gold="sponsored"]')) {
      expect(el.firstElementChild?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
    }
    for (let i = 1; i <= 3; i++) {
      s.applyContext(ctx()); // what the popup's refresh does: re-decide everything
      s.scanNow();
      expect(hiddenGold(), `rescan ${i}`).toEqual([true, true]);
      expect(s.state().hiddenNow, `rescan ${i} hiddenNow`).toBe(2);
    }
    // And the placeholder is back where it was after every read.
    for (const el of document.querySelectorAll('[data-gold="sponsored"]')) {
      expect(el.firstElementChild?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
    }
  });

  it('a read that throws on a rescan leaves the hidden unit masked, with its placeholder in place', () => {
    load('threads-feed.html');
    const host = 'www.threads.com';
    const ctx = () => defaultContext('threads.com', { categories: ON });
    const s = new Scanner({
      doc: document,
      hostname: host,
      baseUrl: `https://${host}/`,
      adapter: adapterFor(host),
      context: ctx(),
      persistOverride: () => undefined,
      schedule: (fn) => fn(),
    });
    s.scanNow();
    expect(hiddenGold(), 'positive control: first scan').toEqual([true, true]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(extract, 'unitText').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      s.applyContext(ctx());
      s.scanNow();
      expect(s.state().perf.decideErrors, 'positive control: the read threw').toBeGreaterThan(0);
      // Still hidden, placeholder still first child: the failed read restored both.
      expect(hiddenGold()).toEqual([true, true]);
      for (const el of document.querySelectorAll('[data-gold="sponsored"]')) {
        expect(el.firstElementChild?.hasAttribute(PLACEHOLDER_ATTR)).toBe(true);
      }
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
