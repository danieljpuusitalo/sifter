import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { settleInstall } from './install';

// Loads the real built extension (.output/chrome-mv3) into Chromium, serves the
// public fixtures at the real site URLs, and blocks every other request, so no
// test ever touches a live site.

// The service worker's `chrome` global, as far as these tests use it (the code runs
// inside the extension via sw.evaluate, not in Node).
declare const chrome: {
  storage: { local: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> } };
  tabs: {
    query(q: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

const EXT = resolve('.output/chrome-mv3');
const FIXTURES: Record<string, string> = {
  'www.linkedin.com': 'linkedin-feed.html',
  'www.google.com': 'google-search.html',
  'www.reddit.com': 'reddit-home.html',
  'x.com': 'x-home.html',
  'www.instagram.com': 'instagram-feed.html',
  'www.facebook.com': 'facebook-feed.html',
  'www.threads.com': 'threads-feed.html',
};

const test = base.extend<{ context: BrowserContext; page: Page }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue(); // the extension's own pages
      const file = FIXTURES[url.hostname];
      if (url.protocol === 'https:' && file && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: readFileSync(join('fixtures', 'public', file), 'utf8') });
      }
      return route.abort();
    });
    // Wait for the service worker so storage and messaging are up before the first page.
    if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
    await settleInstall(context);
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },
});

const card = (page: Page, key: string) => page.locator(`[componentkey^="update-card-focus${key}"]`);
const placeholderFor = (page: Page, key: string) =>
  page.locator(`[data-sifter-placeholder]:has(+ [componentkey^="update-card-focus${key}"])`);

test('hides sponsored units and leaves organic ones on every launch site', async ({ page }) => {
  for (const [host, file] of Object.entries(FIXTURES)) {
    await page.goto(`https://${host}/`);
    await expect(page.locator('.sifter-hidden').first(), file).toBeAttached();
    // Decisions land in idle slices, so the page converges rather than flipping at once.
    const wrong = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-gold]'))
          .filter((el) => el.classList.contains('sifter-hidden') !== (el.getAttribute('data-gold') === 'sponsored'))
          .map((el) => (el.textContent ?? '').trim().slice(0, 50)),
      );
    await expect.poll(wrong, { message: file, timeout: 5000 }).toEqual([]);
  }
});

test('the placeholder is styled by its shared constructed sheet', async ({ page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(page.locator('[data-sifter-placeholder]').first()).toBeAttached();
  const styled = await page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('[data-sifter-placeholder]'));
    return hosts.map((host) => {
      const root = host.shadowRoot!;
      const row = root.querySelector('.row') as HTMLElement;
      return {
        styleElements: root.querySelectorAll('style').length,
        adopted: root.adoptedStyleSheets.length,
        display: getComputedStyle(row).display,
      };
    });
  });
  expect(styled.length).toBeGreaterThan(1);
  for (const s of styled) expect(s).toEqual({ styleElements: 0, adopted: 1, display: 'flex' });
});

test('Show reveals the unit for this page only', async ({ page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();
  await expect(placeholderFor(page, '1002')).toContainText('Hidden sponsored post');
  await placeholderFor(page, '1002').locator('[data-act="show"]').click();
  await expect(card(page, '1002')).toBeVisible();
  await expect(placeholderFor(page, '1002')).toHaveCount(0);

  await page.reload();
  await expect(card(page, '1002')).toBeHidden();
});

test('"Not an ad" reveals the unit and remembers it across reloads', async ({ page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1004')).toBeHidden();
  await placeholderFor(page, '1004').locator('[data-act="not-ad"]').click();
  await expect(card(page, '1004')).toBeVisible();

  await page.reload();
  await expect(card(page, '1002')).toBeHidden(); // the extension is running
  await expect(card(page, '1004')).toBeVisible(); // and the override held
  await expect(placeholderFor(page, '1004')).toHaveCount(0);
});

test('popup renders, and the page reports counts to it', async ({ context, page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();

  // The message the popup sends to the active tab, sent from the service worker.
  // Decisions land in idle slices, so poll until the page has converged.
  const [sw] = context.serviceWorkers();
  const pageState = () =>
    sw!.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
      return chrome.tabs.sendMessage(tabs[0]!.id!, { type: 'sifter:getPageState' });
    });
  await expect
    .poll(pageState, { timeout: 5000 })
    .toMatchObject({ siteKey: 'linkedin.com', enabled: true, adapter: 'linkedin', counts: { sponsored: 3 }, hiddenNow: 3 });

  const id = new URL(sw!.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'Sifter' })).toBeVisible();
  await expect(popup.getByText('nothing leaves your browser')).toBeVisible();
});

test('units added by infinite scroll are hidden too', async ({ page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<div role="listitem" componentkey="update-card-focus3001x"><div><p componentkey="s1"><span>Late Co</span></p><p componentkey="s2"><span>Promoted</span></p></div><p componentkey="s3"><span>Scrolled-in ad.</span></p></div>' +
      '<div role="listitem" componentkey="update-card-focus3002x"><div><p componentkey="s4"><span>A Person</span></p><p componentkey="s5"><span>Teacher · 1h</span></p></div><p componentkey="s6"><span>Scrolled-in organic post.</span></p></div>';
    document.querySelector('[data-testid="mainFeed"]')?.append(wrap);
  });
  await expect(card(page, '3001')).toBeHidden();
  await expect(card(page, '3002')).toBeVisible();
});

/** Change stored settings from the service worker, as the options page would. */
async function patchSettings(context: BrowserContext, patch: Record<string, unknown>) {
  const [sw] = context.serviceWorkers();
  await sw!.evaluate(async (p) => {
    const got = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...((got.settings as object) ?? {}), ...p } });
  }, patch);
}

test('turning on "suggested" in settings hides suggested units in open tabs', async ({ context, page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();
  await expect(card(page, '1009')).toBeVisible(); // suggested is off by default
  await patchSettings(context, { categories: { sponsored: true, suggested: true, custom: true } });
  await expect(card(page, '1009')).toBeHidden();
  await expect(placeholderFor(page, '1009')).toContainText('Hidden suggestion');
  await expect(card(page, '1010')).toBeVisible(); // "suggested" in the body is not a label
});

test('muted words and element rules hide as "custom"', async ({ context, page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();
  await patchSettings(context, { mutedWords: ['sourdough', 'interviews'], rulesText: 'linkedin.com##[componentkey^="update-card-focus1005"]' });
  await expect(card(page, '1009')).toBeHidden(); // "user interviews"
  await expect(card(page, '1005')).toBeHidden(); // element rule
  await expect(card(page, '1001')).toBeVisible();
});

test('"Hide this post" from the context menu hides the unit and remembers it', async ({ context, page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();
  // A real right-click, not dispatchEvent: the content script now ignores an
  // untrusted contextmenu event, and dispatchEvent's is never trusted.
  await card(page, '1001').locator('span').first().click({ button: 'right' });
  const [sw] = context.serviceWorkers();
  const res = await sw!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    return chrome.tabs.sendMessage(tabs[0]!.id!, { type: 'sifter:hideTarget' });
  });
  expect(res).toEqual({ ok: true });
  await expect(card(page, '1001')).toBeHidden();
  // A settings change re-decides every unit, the hidden ones included: the stored hide must still match.
  await patchSettings(context, { hideMode: 'collapse', mutedWords: ['zzz-unused'] });
  await page.waitForTimeout(600);
  await expect(card(page, '1001')).toBeHidden();
  await page.reload();
  await expect(card(page, '1002')).toBeHidden();
  await expect(card(page, '1001')).toBeHidden();
});

test('options page: global category, per-site override and rule validation reach open tabs', async ({ context, page }) => {
  await page.goto('https://www.linkedin.com/');
  await expect(card(page, '1002')).toBeHidden();
  await expect(card(page, '1009')).toBeVisible();

  const id = new URL(context.serviceWorkers()[0]!.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await expect(options.getByRole('row')).toHaveCount(8); // header + 7 launch sites

  await options.getByRole('checkbox', { name: /Suggested posts/ }).check();
  await expect(card(page, '1009')).toBeHidden();

  // A site's own setting beats the global one.
  await options.getByRole('combobox', { name: 'Suggested posts on LinkedIn' }).selectOption('off');
  await expect(card(page, '1009')).toBeVisible();
  await expect(card(page, '1002')).toBeHidden();

  // A bad rule is reported and skipped; the good one still applies.
  await options.getByRole('textbox', { name: /Element rules/ }).fill('linkedin.com##[componentkey^="update-card-focus1005"]\nlinkedin.com##div[[');
  await expect(options.getByText('Line 2:')).toBeVisible();
  await options.getByRole('button', { name: 'Save filters' }).click();
  await expect(options.getByRole('status')).toContainText('1 rule');
  await expect(card(page, '1005')).toBeHidden();
});

test('sifter:setOverride rejects a malformed fingerprint or action instead of storing it', async ({ context, page }) => {
  // A service worker can't message itself, so send from an extension page, which
  // the background trusts the same way it trusts the popup and options page.
  const [sw] = context.serviceWorkers();
  const id = new URL(sw!.url()).host;
  await page.goto(`chrome-extension://${id}/popup.html`);
  const send = (msg: unknown) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await expect(send({ type: 'sifter:setOverride', hostname: 'linkedin.com', fp: 'abc123', action: 'hide' })).resolves.toEqual({ ok: true });
  await expect(send({ type: 'sifter:setOverride', hostname: 'linkedin.com', fp: '../../etc/passwd', action: 'hide' })).resolves.toEqual({
    error: 'invalid override',
  });
  await expect(send({ type: 'sifter:setOverride', hostname: 'linkedin.com', fp: 'abc123', action: 'delete-everything' })).resolves.toEqual({
    error: 'invalid override',
  });
  const stored = await sw!.evaluate(async () => chrome.storage.local.get('overrides'));
  expect(Object.keys((stored['overrides'] as Record<string, Record<string, unknown>>)['linkedin.com'] ?? {})).toEqual(['abc123']);
});

test('switching a site off shows everything on it', async ({ context, page }) => {
  await page.goto('https://x.com/');
  await expect(page.locator('.sifter-hidden')).toHaveCount(2);
  await patchSettings(context, { sites: { 'x.com': { enabled: false } } });
  await expect(page.locator('.sifter-hidden')).toHaveCount(0);
});
