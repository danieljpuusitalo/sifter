import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { settleInstall } from './install';

// Google does not ship the top "Sponsored products" carousel in the server HTML:
// it is rendered client-side after load (seen live 2026-09-24, a re-fetch of the
// results page held #tads but no [data-dsktp-pla]). So the initial scan never
// sees it and only the mutation path can hide it. Three insertion shapes below.

const EXT = resolve('.output/chrome-mv3');

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
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.protocol === 'https:' && url.hostname === 'www.google.com' && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: readFileSync(join('fixtures', 'public', 'google-search.html'), 'utf8') });
      }
      return route.abort();
    });
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

const CAROUSEL =
  '<div class="vbIt3d" data-dsktp-pla="true" data-late="1"><div class="GUyUUb"><span class="L8u9l">Sponsored products</span>' +
  '<div class="pla"><a id="plap_9" href="https://www.google.com/aclk?sa=l&amp;ai=late">Late Shoe</a></div></div></div>';

const late = (page: Page) => page.locator('[data-late="1"]');

test.beforeEach(async ({ page }) => {
  await page.goto('https://www.google.com/search?q=shoes');
  await expect(page.locator('#tads')).toHaveClass(/sifter-hidden/);
});

test('carousel appended as a whole subtree after load is hidden', async ({ page }) => {
  await page.evaluate((html) => {
    const wrap = document.createElement('div');
    wrap.className = 'SLPe5b';
    wrap.innerHTML = html;
    document.getElementById('cnt')!.prepend(wrap);
  }, CAROUSEL);
  await expect(late(page)).toHaveClass(/sifter-hidden/);
});

// The second live shape (google.nl, 2026-09-24): no data-dsktp-pla, the block is #atvcap.
const ATVCAP =
  '<div id="atvcap" data-st-cnt="atvcap" data-late="1"><div class="GUyUUb" data-hb="tcu"><div data-pla="1"><h3>Sponsored products</h3>' +
  '<div class="pla"><a id="plap_9x" href="https://www.google.com/aclk?sa=l&amp;ai=late2">Late Boot</a></div></div></div></div>';

test('#atvcap carousel appended after load is hidden', async ({ page }) => {
  await page.evaluate((html) => {
    const wrap = document.createElement('div');
    wrap.className = 'SLPe5b';
    wrap.innerHTML = html;
    document.getElementById('cnt')!.prepend(wrap);
  }, ATVCAP);
  await expect(late(page)).toHaveClass(/sifter-hidden/);
});

test('carousel filled into an existing empty wrapper is hidden', async ({ page }) => {
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.className = 'SLPe5b';
    document.getElementById('cnt')!.prepend(wrap);
  });
  await page.waitForTimeout(600);
  await page.evaluate((html) => {
    document.querySelector('.SLPe5b')!.innerHTML = html;
  }, CAROUSEL);
  await expect(late(page)).toHaveClass(/sifter-hidden/);
});

// Known gap: the observer watches child lists and text, not attributes, so a
// marker attribute set on a node that was already in the page is never seen.
// Not observed live on Google (the carousel arrives whole, attribute included);
// kept as a fixme so the gap is on record if a site ever does this.
test.fixme('carousel whose marker attribute lands after its content is hidden', async ({ page }) => {
  await page.evaluate((html) => {
    const wrap = document.createElement('div');
    wrap.className = 'SLPe5b';
    wrap.innerHTML = html;
    wrap.firstElementChild!.removeAttribute('data-dsktp-pla');
    document.getElementById('cnt')!.prepend(wrap);
  }, CAROUSEL);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-late="1"]')!.setAttribute('data-dsktp-pla', 'true'));
  await expect(late(page)).toHaveClass(/sifter-hidden/, { timeout: 4000 });
});
