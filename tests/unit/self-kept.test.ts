import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { runAdmin, storeSelf } from '../../src/bg-requests';
import { loadSettings, parseSettings, pruneSelf, saveSettings, suggestedOn } from '../../src/storage/settings';

// The viewer's profile id is kept only while "suggested" is on for the site: it
// exists to keep posts that mention them from being hidden as suggested, and for
// nothing else.

const ME = 'test-viewer';
const KEY = 'linkedin.com';
const withSelfStored = (over: Record<string, unknown> = {}, site: Record<string, unknown> = {}) =>
  parseSettings({ ...over, sites: { [KEY]: { self: ME, ...site } } });
const selfOf = (s: { sites: Record<string, { self?: string }> }) => s.sites[KEY]?.self;

describe('pruneSelf', () => {
  it('keeps the id while suggested is on (global toggle), drops it once off', () => {
    const on = { categories: { sponsored: true, suggested: true, custom: true } };
    expect(selfOf(pruneSelf(withSelfStored(on) as never))).toBe(ME);
    expect(selfOf(pruneSelf({ ...withSelfStored(on), categories: { sponsored: true, suggested: false, custom: true } }))).toBeUndefined();
  });
  it("the site's own suggested override wins over the global toggle, both ways", () => {
    const off = { categories: { sponsored: true, suggested: false, custom: true } };
    const on = { categories: { sponsored: true, suggested: true, custom: true } };
    expect(selfOf(withSelfStored(off, { categories: { suggested: true } }))).toBe(ME);
    expect(selfOf(withSelfStored(on, { categories: { suggested: false } }))).toBeUndefined();
  });
  it('drops it when the site is disabled, even with suggested on', () => {
    const on = { categories: { sponsored: true, suggested: true, custom: true } };
    expect(selfOf(withSelfStored(on))).toBe(ME);
    expect(selfOf(withSelfStored(on, { enabled: false }))).toBeUndefined();
  });
  it('keeps the rest of the site settings and returns the same object when nothing is dropped', () => {
    const s = withSelfStored({ categories: { sponsored: true, suggested: true, custom: true } }, { rules: { groups: false } });
    expect(pruneSelf(s)).toBe(s);
    const dropped = withSelfStored({}, { rules: { groups: false } });
    expect(dropped.sites[KEY]).toEqual({ rules: { groups: false } });
  });
  it('suggestedOn follows the site override, then the global toggle', () => {
    const s = parseSettings({ categories: { sponsored: true, suggested: true, custom: true }, sites: { [KEY]: { categories: { suggested: false } } } });
    expect(suggestedOn(s, KEY)).toBe(false);
    expect(suggestedOn(s, 'reddit.com')).toBe(true);
  });
});

describe('storage', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
  });
  const ON = { sponsored: true, suggested: true, custom: true };

  it('load drops a stored id when suggested is off, and keeps it when on', async () => {
    await browser.storage.local.set({ settings: { sites: { [KEY]: { self: ME } } } });
    expect(selfOf(await loadSettings())).toBeUndefined();
    await browser.storage.local.set({ settings: { categories: ON, sites: { [KEY]: { self: ME } } } });
    expect(selfOf(await loadSettings())).toBe(ME);
  });
  it('save stores no id once suggested is off', async () => {
    await saveSettings({ ...parseSettings({ categories: ON, sites: { [KEY]: { self: ME } } }) });
    expect(selfOf(await loadSettings())).toBe(ME);
    const off = { ...parseSettings({ categories: ON, sites: { [KEY]: { self: ME } } }), categories: { ...ON, suggested: false } };
    await saveSettings(off);
    const raw = (await browser.storage.local.get('settings')).settings as { sites: Record<string, { self?: string }> };
    expect(raw.sites[KEY]?.self).toBeUndefined();
  });
  it('turning suggested off drops a stored id from storage, not just from the view', async () => {
    await saveSettings(parseSettings({ categories: ON, sites: { [KEY]: { self: ME } } }));
    await saveSettings({ ...(await loadSettings()), categories: { ...ON, suggested: false } });
    const raw = (await browser.storage.local.get('settings')).settings as { sites: Record<string, { self?: string }> };
    expect(raw.sites[KEY]?.self).toBeUndefined();
  });
  it('a backup with suggested off and an id stores no id; with suggested on it does', async () => {
    const backup = (suggested: boolean) => ({
      app: 'sifter',
      version: 1,
      settings: { categories: { sponsored: true, suggested, custom: true }, sites: { [KEY]: { self: ME } } },
      overrides: {},
    });
    expect(await runAdmin({ type: 'sifter:importBackup', backup: backup(true) })).toEqual({ ok: true });
    expect(selfOf(await loadSettings()), 'positive control: kept with suggested on').toBe(ME);
    expect(await runAdmin({ type: 'sifter:importBackup', backup: backup(false) })).toEqual({ ok: true });
    const raw = (await browser.storage.local.get('settings')).settings as { sites: Record<string, { self?: string }> };
    expect(raw.sites[KEY]?.self).toBeUndefined();
  });
  it('the service worker ignores a learned id while suggested is off, stores it while on, and always forgets', async () => {
    await storeSelf('www.linkedin.com', ME);
    expect(selfOf(await loadSettings())).toBeUndefined();
    // not even a write, so open tabs are not re-decided for nothing
    expect((await browser.storage.local.get('settings')).settings).toBeUndefined();
    await saveSettings(parseSettings({ categories: ON }));
    await storeSelf('www.linkedin.com', ME);
    expect(selfOf(await loadSettings()), 'positive control').toBe(ME);
    await storeSelf('www.linkedin.com', null);
    expect(selfOf(await loadSettings())).toBeUndefined();
  });
});
