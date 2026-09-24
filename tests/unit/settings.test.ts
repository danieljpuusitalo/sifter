import { describe, expect, it } from 'vitest';
import { isPaused, isSiteEnabled, parseOverrides, parseSettings, siteKey } from '../../src/storage/settings';

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
});
