import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { authorize, runAdmin } from '../../src/bg-requests';
import type { BgRequest } from '../../src/messages';
import { loadOverrides, loadSettings, setOverride } from '../../src/storage/settings';

const self = { id: 'abc', baseUrl: 'chrome-extension://abc/' };
const page = { id: 'abc', url: 'chrome-extension://abc/options.html' };
const content = { id: 'abc', url: 'https://www.linkedin.com/feed/' };

describe('authorize: the whole-store writes are extension-page-only', () => {
  const admin: BgRequest[] = [
    { type: 'sifter:importBackup', backup: {} },
    { type: 'sifter:clearOverrides', key: null },
  ];
  for (const msg of admin) {
    it(`${msg.type}: a content script is refused, the options page is allowed`, () => {
      expect(authorize(msg, content, self)).toBeNull();
      expect(authorize(msg, page, self)).toBe(msg);
    });
  }
  it('another extension is refused, even from a page of its own', () => {
    expect(authorize(admin[0]!, { id: 'other', url: 'chrome-extension://other/x.html' }, self)).toBeNull();
  });
  it('positive control: a content script keeps getContext, and its hostname comes from the sender', () => {
    const got = authorize({ type: 'sifter:getContext', hostname: 'evil.example' }, content, self);
    expect(got).toEqual({ type: 'sifter:getContext', hostname: 'www.linkedin.com' });
  });
});

describe('runAdmin', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
  });
  const backup = (over: Record<string, unknown> = {}) => ({
    app: 'sifter',
    version: 1,
    settings: { hideMode: 'blur', mutedWords: ['crypto'] },
    overrides: { 'x.com': { abc: 'not-ad' } },
    ...over,
  });

  it('answers a bad backup with { error } and stores nothing', async () => {
    await setOverride('x.com', 'keep', 'hide');
    expect(await runAdmin({ type: 'sifter:importBackup', backup: backup({ app: 'other' }) })).toEqual({ error: "That file isn't a Sifter backup." });
    expect(await runAdmin({ type: 'sifter:importBackup', backup: 'nope' })).toHaveProperty('error');
    expect((await loadSettings()).hideMode).toBe('collapse');
    expect(await loadOverrides()).toEqual({ 'x.com': { keep: 'hide' } });
  });
  it('positive control: a good backup is stored', async () => {
    expect(await runAdmin({ type: 'sifter:importBackup', backup: backup() })).toEqual({ ok: true });
    expect((await loadSettings()).hideMode).toBe('blur');
    expect(await loadOverrides()).toEqual({ 'x.com': { abc: 'not-ad' } });
  });
  it('clearOverrides refuses a bad key, and clears one site or all', async () => {
    await setOverride('x.com', 'a', 'hide');
    await setOverride('reddit.com', 'b', 'hide');
    expect(await runAdmin({ type: 'sifter:clearOverrides', key: '' })).toHaveProperty('error');
    expect(await runAdmin({ type: 'sifter:clearOverrides', key: 'x'.repeat(300) })).toHaveProperty('error');
    expect(await runAdmin({ type: 'sifter:clearOverrides', key: 5 as never })).toHaveProperty('error');
    expect(Object.keys(await loadOverrides()).sort()).toEqual(['reddit.com', 'x.com']);
    expect(await runAdmin({ type: 'sifter:clearOverrides', key: 'x.com' })).toEqual({ ok: true });
    expect(Object.keys(await loadOverrides())).toEqual(['reddit.com']);
    expect(await runAdmin({ type: 'sifter:clearOverrides', key: null })).toEqual({ ok: true });
    expect(await loadOverrides()).toEqual({});
  });
});
