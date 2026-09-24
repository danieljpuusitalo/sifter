import { describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { isPaused, isSiteEnabled, loadOverrides, parseOverrides, parseSettings, setOverride, siteKey } from '../../src/storage/settings';

describe('settings', () => {
  it('fills defaults', () =>
    expect(parseSettings(undefined)).toEqual({ version: 1, sites: {}, optInHosts: [], pausedUntil: null, hideMode: 'collapse', categories: { sponsored: true, suggested: false, custom: true }, mutedWords: [], rulesText: '' }));
  it('falls back to defaults when corrupt', () => expect(parseSettings({ hideMode: 'explode' }).hideMode).toBe('collapse'));
  it('drops junk overrides', () => expect(parseOverrides({ 'x.com': { abc: 'nuke' } })).toEqual({}));
  it('keeps valid overrides', () => expect(parseOverrides({ 'x.com': { abc: 'not-ad' } })).toEqual({ 'x.com': { abc: 'not-ad' } }));
  it('site key strips www only', () => {
    expect(siteKey('www.linkedin.com')).toBe('linkedin.com');
    expect(siteKey('old.reddit.com')).toBe('old.reddit.com');
  });
  it('launch sites default on, others default off, explicit setting wins', () => {
    const s = parseSettings({ sites: { 'google.nl': { enabled: false } } });
    expect(isSiteEnabled(s, 'linkedin.com', true)).toBe(true);
    expect(isSiteEnabled(s, 'news.example', false)).toBe(false);
    expect(isSiteEnabled(s, 'google.nl', true)).toBe(false);
  });
  it('pause expires', () => {
    const s = parseSettings({ pausedUntil: 1000 });
    expect(isPaused(s, 999)).toBe(true);
    expect(isPaused(s, 1001)).toBe(false);
  });
  it('one bad field costs that field only, not the whole configuration', () => {
    const s = parseSettings({ hideMode: 'explode', mutedWords: 'nope', categories: { suggested: true }, rulesText: '##.x' });
    expect(s.hideMode).toBe('collapse');
    expect(s.mutedWords).toEqual([]);
    expect(s.categories).toEqual({ sponsored: true, suggested: true, custom: true });
    expect(s.rulesText).toBe('##.x');
    expect(parseSettings('garbage').version).toBe(1);
  });
  it('opt-in hosts must be plain hostnames, so each is a safe match pattern', () => {
    const s = parseSettings({ optInHosts: ['News.Example', '*', 'a.example:8080', 'b.example/path', '*.c.example', 'news.example', 'localhost'] });
    expect(s.optInHosts).toEqual(['news.example']);
  });
  it('caps sizes a hostile backup could inflate', () => {
    const s = parseSettings({ mutedWords: ['x'.repeat(101), ...Array.from({ length: 300 }, (_, i) => `w${i}`)], rulesText: 'a'.repeat(60_000) });
    expect(s.mutedWords).toHaveLength(200);
    expect(s.mutedWords[0]).toBe('w0');
    expect(s.rulesText).toHaveLength(50_000);
  });
  it('aliases fold into one site key', () => {
    expect(siteKey('twitter.com')).toBe('x.com');
    expect(siteKey('www.google.nl')).toBe('google.com');
    expect(siteKey('www.threads.net')).toBe('threads.com');
  });
  it('site key does not fall through to Object.prototype members', () => {
    expect(siteKey('constructor')).toBe('constructor');
    expect(siteKey('toString')).toBe('tostring');
    expect(siteKey('hasOwnProperty')).toBe('hasownproperty');
  });
  it('a bad entry costs only itself, not its site or the whole record', () => {
    expect(parseOverrides({ 'x.com': { abc: 'not-ad', bad: 'nuke' }, 'y.com': 'not an object' })).toEqual({
      'x.com': { abc: 'not-ad' },
    });
  });
  it('an old plain-string override entry is tolerated', () => {
    expect(parseOverrides({ 'x.com': { abc: 'hide' } })).toEqual({ 'x.com': { abc: 'hide' } });
  });

  describe('override caps', () => {
    // Write the raw, timestamped shape straight into storage (one call) rather than
    // driving 2000+ individual setOverride writes through the serial queue, which
    // is realistic but far too slow for a test.
    it('caps a single site at 2000 entries, dropping the oldest first', async () => {
      const entries: Record<string, { action: 'not-ad'; t: number }> = {};
      for (let i = 0; i < 2005; i++) entries[`fp${i}`] = { action: 'not-ad', t: i };
      await browser.storage.local.set({ overrides: { 'x.com': entries } });
      const stored = await loadOverrides();
      expect(Object.keys(stored['x.com']!)).toHaveLength(2000);
      // The lowest timestamps are the oldest, so they're the ones dropped.
      expect(stored['x.com']!['fp0']).toBeUndefined();
      expect(stored['x.com']!['fp2004']).toBe('not-ad');
    });

    it('caps the total across every site at 10000, dropping the oldest whole site first', async () => {
      const bySite: Record<string, Record<string, { action: 'not-ad'; t: number }>> = {};
      for (let site = 0; site < 6; site++) {
        const entries: Record<string, { action: 'not-ad'; t: number }> = {};
        for (let i = 0; i < 2000; i++) entries[`fp${i}`] = { action: 'not-ad', t: site * 10_000 + i };
        bySite[`site${site}.example`] = entries;
      }
      await browser.storage.local.set({ overrides: bySite });
      const stored = await loadOverrides();
      const total = Object.values(stored).reduce((n, site) => n + Object.keys(site).length, 0);
      expect(total).toBe(10_000);
      // site0 has the lowest timestamps, so it's the whole site dropped.
      expect(stored['site0.example']).toBeUndefined();
      expect(Object.keys(stored['site5.example']!)).toHaveLength(2000);
    });

    it('setOverride stamps a fresh entry with a timestamp newer than existing ones', async () => {
      await browser.storage.local.set({ overrides: { 'x.com': { old: { action: 'not-ad', t: 0 } } } });
      await setOverride('x.com', 'new', 'hide');
      const stored = await loadOverrides();
      expect(stored['x.com']).toEqual({ old: 'not-ad', new: 'hide' });
    });
  });
});
