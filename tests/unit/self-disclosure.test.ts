import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { App } from '../../entrypoints/options/App.tsx';
import { SELF_DISCLOSURE } from '../../src/self';

// Wherever "suggested" can be turned on for LinkedIn, say what that keeps on the
// device, before it is turned on.

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('options page: the profile-link disclosure', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.spyOn(browser.permissions, 'getAll').mockResolvedValue({ origins: [], permissions: [] } as never);
    vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({ version: '0.0.0' } as never);
    document.body.innerHTML = '';
  });
  afterEach(() => {
    render(null, document.body);
    vi.restoreAllMocks();
  });

  it('shows the line under the global Suggested toggle and in LinkedIn\'s row only, with suggested still off', async () => {
    render(h(App, {}), document.body);
    await flush();
    const toggle = document.querySelector<HTMLInputElement>('ul.cards li:nth-child(2) input[type="checkbox"]')!;
    expect(toggle.checked, 'positive control: suggested is off, so this is shown before turning it on').toBe(false);
    expect(document.querySelector('ul.cards li:nth-child(2)')?.textContent).toContain(SELF_DISCLOSURE);
    expect(document.querySelector('ul.cards li:nth-child(1)')?.textContent).not.toContain(SELF_DISCLOSURE);
    // under the per-site table, where LinkedIn's Suggested select is
    const notes = [...document.querySelectorAll('.self-note')];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe(SELF_DISCLOSURE);
    expect(document.querySelector('table.sites')!.compareDocumentPosition(notes[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
