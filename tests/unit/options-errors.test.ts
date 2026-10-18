import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { App } from '../../entrypoints/options/App.tsx';
import { parseSettings } from '../../src/storage/settings';

// A save the service worker refuses (`{ error }`, which `bg` turns into a throw)
// used to be an unhandled rejection, with the switch left showing a value that
// was never stored.

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('options page: a refused save', () => {
  let send: ReturnType<typeof vi.spyOn>;
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

  const mount = async () => {
    render(h(App, {}), document.body);
    await flush();
  };
  const sponsored = () => document.querySelector<HTMLInputElement>('ul.cards li input[type="checkbox"]')!;

  it('shows the error and puts the switch back to what is stored', async () => {
    send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ error: 'boom' } as never);
    await mount();
    expect(sponsored().checked).toBe(true); // default: on
    expect(document.querySelector('.error')).toBeNull();
    sponsored().click();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.error')?.textContent).toContain('boom');
    expect(sponsored().checked).toBe(true); // nothing was saved
  });

  it('positive control: an accepted save shows no error and keeps the new value', async () => {
    send = vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async (m: { type: string; value: boolean }) => {
      const next = parseSettings({ categories: { sponsored: m.value, suggested: false, custom: true } });
      await browser.storage.local.set({ settings: next });
      return next;
    }) as never);
    await mount();
    sponsored().click();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.error')).toBeNull();
    expect(sponsored().checked).toBe(false);
  });
});
