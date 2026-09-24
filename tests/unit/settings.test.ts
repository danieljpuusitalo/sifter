import { describe, expect, it } from 'vitest';
import { isPaused, isSiteEnabled, parseOverrides, parseSettings, siteKey } from '../../src/storage/settings';

describe('settings', () => {
  it('fills defaults', () =>
    expect(parseSettings(undefined)).toEqual({ version: 1, sites: {}, optInHosts: [], pausedUntil: null, hideMode: 'collapse' }));
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
});
