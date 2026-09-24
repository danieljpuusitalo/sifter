import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';

// Loads the real built extension (.output/chrome-mv3) into Chromium, serves the
// public fixtures at the real site URLs, and blocks every other request, so no
// test ever touches a live site.

// The service worker's `chrome` global, as far as these tests use it (the code runs
// inside the extension via sw.evaluate, not in Node).
declare const chrome: {
  tabs: {
    query(q: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const EXT = resolve('.output/chrome-mv3');
const FIXTURES: Record<string, string> = {
  'www.linkedin.com': 'linkedin-feed.html',
  'www.google.com': 'google-search.html',
  'www.reddit.com': 'reddit-home.html',
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
  page.locator(`[data-sift-placeholder]:has(+ [componentkey^="update-card-focus${key}"])`);

test('hides sponsored units and leaves organic ones on all three sites', async ({ page }) => {
  for (const [host, file] of Object.entries(FIXTURES)) {
    await page.goto(`https://${host}/`);
    await expect(page.locator('.sift-hidden').first(), file).toBeAttached();
    const wrong = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-gold]'))
        .filter((el) => el.classList.contains('sift-hidden') !== (el.getAttribute('data-gold') === 'sponsored'))
        .map((el) => (el.textContent ?? '').trim().slice(0, 50)),
    );
    expect(wrong, file).toEqual([]);
  }
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
  const [sw] = context.serviceWorkers();
  const state = await sw!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    return chrome.tabs.sendMessage(tabs[0]!.id!, { type: 'sift:getPageState' });
  });
  expect(state).toMatchObject({ siteKey: 'linkedin.com', enabled: true, adapter: 'linkedin', counts: { sponsored: 3 }, hiddenNow: 3 });

  const id = new URL(sw!.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'Sift' })).toBeVisible();
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
