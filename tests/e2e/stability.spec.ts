import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { settleInstall } from './install';

// The feed must never move under the reader when Sifter hides something.
//
// A sponsored card is inserted late, on screen, the way an infinite feed appends
// one. Sifter veils it: its content stops painting, but its height stays, so the
// organic card below it does not move. Once the card leaves the screen it
// collapses: at once when it leaves through the bottom, and when it leaves
// through the top, after scrolling stops, with the move undone by Sifter's own
// scroll (it lands before Chrome's anchoring would, and works where a page turns
// anchoring off).

const EXT = resolve('.output/chrome-mv3');
const HOST = 'www.linkedin.com';
const FIXTURE = readFileSync(join('fixtures', 'public', 'linkedin-feed.html'), 'utf8');
const PATH = /<meta\s+name="sifter-path"\s+content="([^"]+)"/.exec(FIXTURE)?.[1] ?? '/';

const test = base.extend<{ context: BrowserContext; page: Page }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 720 },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.protocol === 'https:' && url.hostname === HOST && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: FIXTURE });
      }
      return route.abort();
    });
    if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
    await settleInstall(context);
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

const CARD = '[componentkey^="update-card-focus"]';
const LATE = 'update-card-focus9001FeedType_MAIN_FEED_RELEVANCE';
const late = (page: Page) => page.locator(`[componentkey="${LATE}"]`);

/** Load the feed with tall cards (a real feed's are), wait for the first hides to land and settle. */
async function open(page: Page, css = ''): Promise<void> {
  await page.goto(`https://${HOST}${PATH}`);
  await page.addStyleTag({ content: `${CARD} { min-height: 300px; box-sizing: border-box; } ${css}` });
  await expect(page.locator('[componentkey^="update-card-focus1004"]')).toHaveClass(/\bsifter-hidden\b/);
  await page.waitForTimeout(500);
}

/**
 * Put organic card 1005 near the top of the screen, then insert a copy of sponsored
 * card 1002 right above it, as a feed would append one. Returns 1005's top once the
 * page itself has finished moving it (the insertion is the site's shift, not ours), and
 * whether Sifter hid the copy before that shift painted (then a shift watch starts too late).
 */
async function insertLateAd(page: Page): Promise<{ top: number; hiddenEarly: boolean }> {
  await page.evaluate(() => {
    const ref = document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement;
    const main = document.getElementById('workspace') as HTMLElement;
    const inElement = getComputedStyle(main).overflowY === 'auto';
    const clipTop = inElement ? main.getBoundingClientRect().top : 0;
    (inElement ? main : window).scrollBy(0, ref.getBoundingClientRect().top - clipTop - 100);
  });
  await page.waitForTimeout(500);
  return page.evaluate(async (key) => {
    const src = document.querySelector('[componentkey^="update-card-focus1002"]') as HTMLElement;
    const ref = document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement;
    const clone = src.cloneNode(true) as HTMLElement;
    clone.setAttribute('componentkey', key);
    clone.removeAttribute('data-gold');
    clone.removeAttribute('style');
    for (const c of [...clone.classList]) if (c.startsWith('sifter-')) clone.classList.remove(c);
    clone.querySelector(':scope > [data-sifter-placeholder]')?.remove();
    ref.before(clone);
    // Let the insertion paint, so its own layout shift lands before anyone watches for Sifter's.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return { top: ref.getBoundingClientRect().top, hiddenEarly: clone.classList.contains('sifter-hidden') };
  }, LATE);
}

/** Layout shifts from now on that moved anything on screen, in px (scrolls are not shifts). */
async function watchShifts(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const w = window as unknown as { __moves: number[] };
        w.__moves = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as {
            sources: { previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
          }[]) {
            for (const s of e.sources ?? []) {
              const on = (r: DOMRectReadOnly) => r.height > 0 && r.bottom > 0 && r.top < innerHeight;
              if (on(s.previousRect) || on(s.currentRect)) w.__moves.push(Math.abs(s.currentRect.top - s.previousRect.top));
            }
          }
        }).observe({ type: 'layout-shift' });
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
  return () => page.evaluate(() => (window as unknown as { __moves: number[] }).__moves.filter((m) => m > 0.5));
}

declare const chrome: {
  tabs: { query(q: { url: string }): Promise<Array<{ id?: number }>>; sendMessage(tabId: number, message: unknown): Promise<unknown> };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

/** The page's scanner counters, asked the way the popup asks. */
const perf = (context: BrowserContext) =>
  context.serviceWorkers()[0]!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    const state = (await chrome.tabs.sendMessage(tabs[0]!.id!, { type: 'sifter:getPageState' })) as {
      perf: { hidesInView: number; veilsSettled: number; anchorCorrections: number };
    };
    return state.perf;
  });

const topOf = (page: Page, sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().top, sel);

test('a sponsored card hidden on screen keeps its height: nothing below it moves', async ({ page }) => {
  await open(page);
  const { top: before, hiddenEarly } = await insertLateAd(page);
  expect(hiddenEarly, 'hidden before the insertion painted: the shift watch would start too late').toBe(false);
  const moves = await watchShifts(page);
  await expect(late(page)).toHaveClass(/\bsifter-hidden\b/);
  await page.waitForTimeout(600);
  // Geometry first: the classes below say how it held still, this says whether it did.
  expect(Math.abs((await topOf(page, '[componentkey^="update-card-focus1005"]')) - before)).toBeLessThanOrEqual(1);
  expect(await moves()).toEqual([]);
  await expect(late(page), 'veiled, not collapsed, while on screen').toHaveClass(/\bsifter-veil\b/);
  await expect(late(page)).not.toHaveClass(/\bsifter-collapse\b/);
  // The bar sits over the veiled space (its host is zero-height; the row overflows it),
  // and a real click on Show reaches it through the clipped content.
  const row = page.locator(`[componentkey="${LATE}"] > [data-sifter-placeholder] .row`);
  await expect(row).toBeVisible();
  await row.locator('[data-act="show"]').click();
  await expect(late(page)).not.toHaveClass(/\bsifter-hidden\b/);
  await expect(late(page)).not.toHaveClass(/\bsifter-veil\b/);
});

test('a veiled card that leaves through the bottom collapses', async ({ page }) => {
  await open(page);
  await insertLateAd(page);
  await expect(late(page)).toHaveClass(/\bsifter-veil\b/);
  await page.evaluate(() => window.scrollBy(0, -1200));
  await expect(late(page)).toHaveClass(/\bsifter-collapse\b/);
  await expect(late(page)).not.toHaveClass(/\bsifter-veil\b/);
});

// Where the feed scrolls, and how far down its visible area starts.
const SCROLLERS = [
  { name: 'the page, overflow-anchor: auto', css: '' },
  { name: 'the page, overflow-anchor: none', css: 'html, body { overflow-anchor: none; }' },
  // LinkedIn's shape: the feed scrolls inside <main>, whose top edge sits under a header
  // (and, measured live, Chrome does not anchor its collapses there).
  // A card scrolled up behind that edge is clipped (not intersecting) while its bottom is
  // still below the top of the window: it is above the reader, not below.
  {
    name: 'an element clipped under a header, no anchoring',
    css: 'html, body { height: 100%; margin: 0; overflow: hidden; } #workspace { position: fixed; top: 100px; bottom: 0; left: 0; right: 0; overflow-y: auto; overflow-anchor: none; }',
  },
] as const;

for (const variant of SCROLLERS) {
  test(`a veiled card that leaves through the top collapses without moving the screen (${variant.name})`, async ({ context, page }) => {
    await open(page, variant.css);
    await insertLateAd(page);
    await expect(late(page)).toHaveClass(/\bsifter-veil\b/);
    const moves = await watchShifts(page);
    // Scroll the late card off the top, and note where the first visible organic card sits.
    const ref = await page.evaluate((key) => {
      const main = document.getElementById('workspace') as HTMLElement;
      const inElement = getComputedStyle(main).overflowY === 'auto';
      const clipTop = inElement ? main.getBoundingClientRect().top : 0;
      const late = document.querySelector(`[componentkey="${key}"]`) as HTMLElement;
      // In the page: well clear of the top. In the element: its bottom 40 px into the clipped band.
      const by = inElement ? late.getBoundingClientRect().bottom - (clipTop - 40) : 700;
      (inElement ? main : window).scrollBy(0, by);
      const r = late.getBoundingClientRect();
      if (r.bottom > clipTop) throw new Error(`late card still on screen: bottom ${r.bottom}, visible from ${clipTop}`);
      for (const el of document.querySelectorAll<HTMLElement>('[componentkey^="update-card-focus"]:not(.sifter-hidden)')) {
        const top = el.getBoundingClientRect().top;
        if (top > clipTop && top < innerHeight) return { key: el.getAttribute('componentkey') as string, top };
      }
      throw new Error('no organic card on screen');
    }, LATE);
    await expect(late(page)).toHaveClass(/\bsifter-collapse\b/);
    await page.waitForTimeout(300);
    const after = await topOf(page, `[componentkey="${ref.key}"]`);
    expect(Math.abs(after - ref.top), `${ref.key} moved from ${ref.top} to ${after}`).toBeLessThanOrEqual(1);
    // A corrected move is still a layout shift for the few ms before the scroll lands in the same frame; none may reach the screen.
    expect(await moves()).toEqual([]);
    // Positive control: the late card was hidden on screen, and Sifter's scroll ran.
    // With anchoring on, Chrome would undo the move too, but after Sifter reads it, so
    // the scroll lands first in both variants. Without the scroll, 'none' fails.
    const p = await perf(context);
    expect(p.hidesInView, 'positive control: the late card was hidden on screen').toBeGreaterThan(0);
    expect(p.anchorCorrections, 'the collapse moved the page and Sifter undid it').toBeGreaterThan(0);
  });
}

for (const variant of SCROLLERS) {
  test(`a veiled card that went up under the top edge collapses once nearly all of it is gone, without moving the screen (${variant.name})`, async ({ context, page }) => {
    await open(page, variant.css);
    await insertLateAd(page);
    await expect(late(page)).toHaveClass(/\bsifter-veil\b/);
    // Let the tracker take its first look at the veil before the page scrolls.
    await page.waitForTimeout(300);
    const moves = await watchShifts(page);
    const scrollBy = (dy: number | 'nearly-gone') =>
      page.evaluate(([dy, key]) => {
        const main = document.getElementById('workspace') as HTMLElement;
        const inElement = getComputedStyle(main).overflowY === 'auto';
        // The tracker's top edge: the header band, or 8 px into the clipped element.
        const edge = inElement ? Math.max(64, main.getBoundingClientRect().top + 8) : 64;
        const card = document.querySelector(`[componentkey="${key}"]`) as HTMLElement;
        const by = dy === 'nearly-gone' ? card.getBoundingClientRect().bottom - (edge + 30) : dy;
        (inElement ? main : window).scrollBy(0, by);
        return (document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement).getBoundingClientRect().top;
      }, [dy, LATE] as const);
    // 150 px: the late card's top (and its bar) goes under the header or the clipped edge,
    // while most of it is still on screen. Collapsing it there, corrected on its bottom
    // edge, would slide the post above it down into view (live report D).
    await scrollBy(150);
    await page.waitForTimeout(400);
    await expect(late(page)).toHaveClass(/\bsifter-veil\b/);
    // Then on until only its last 30 px are below the edge.
    const before = await scrollBy('nearly-gone');
    await expect(late(page)).toHaveClass(/\bsifter-collapse\b/);
    await page.waitForTimeout(300);
    const after = await topOf(page, '[componentkey^="update-card-focus1005"]');
    expect(Math.abs(after - before), `the card below moved from ${before} to ${after}`).toBeLessThanOrEqual(1);
    expect(await moves()).toEqual([]);
    const p = (await perf(context)) as unknown as { veilsUnderTop: number; anchorCorrections: number };
    expect(p.veilsUnderTop, 'settled because its top went under the edge, not because it left the screen').toBeGreaterThan(0);
    expect(p.anchorCorrections).toBeGreaterThan(0);
  });
}

// Live report, 2026-10-01: pausing (and switching a category off) released every hidden
// card at once, and those above the screen expanded under the reader: the feed jumped.
// Two ways in: pause releases everything in one pass; a switch turned off releases slice by slice.
const RELEASES = [
  { name: 'pausing', on: { type: 'sifter:pause', minutes: 5 }, off: { type: 'sifter:pause', minutes: null } },
  {
    name: 'switching Sponsored off',
    on: { type: 'sifter:setSiteCategory', hostname: HOST, category: 'sponsored', value: false },
    off: { type: 'sifter:setSiteCategory', hostname: HOST, category: 'sponsored', value: null },
  },
] as const;

for (const variant of SCROLLERS) for (const release of RELEASES) {
  test(`${release.name} releases hidden cards above the screen without moving the screen (${variant.name})`, async ({ context, page }) => {
    await open(page, variant.css);
    // Scroll the hidden cards (1002, 1004, 1006) off the top, and note the first organic card on screen.
    const ref = await page.evaluate(() => {
      const main = document.getElementById('workspace') as HTMLElement;
      const inElement = getComputedStyle(main).overflowY === 'auto';
      const clipTop = inElement ? main.getBoundingClientRect().top : 0;
      const target = document.querySelector('[componentkey^="update-card-focus1010"]') as HTMLElement;
      (inElement ? main : window).scrollBy(0, target.getBoundingClientRect().top - clipTop - 100);
      return { clipTop, key: target.getAttribute('componentkey') as string };
    });
    await page.waitForTimeout(500);
    const hidden = page.locator('[componentkey^="update-card-focus1004"]');
    await expect(hidden).toHaveClass(/\bsifter-collapse\b/);
    expect((await hidden.boundingBox())!.y, 'positive control: a hidden card sits above the screen').toBeLessThan(ref.clipTop);
    const before = await topOf(page, `[componentkey="${ref.key}"]`);
    const moves = await watchShifts(page);
    const [sw] = context.serviceWorkers();
    const control = await context.newPage();
    await control.goto(`chrome-extension://${new URL(sw!.url()).host}/popup.html`);
    await control.evaluate((m) => chrome.runtime.sendMessage(m), release.on);
    await expect(hidden).not.toHaveClass(/\bsifter-hidden\b/);
    await page.waitForTimeout(300);
    const after = await topOf(page, `[componentkey="${ref.key}"]`);
    expect(Math.abs(after - before), `${ref.key} moved from ${before} to ${after}`).toBeLessThanOrEqual(1);
    expect(await moves()).toEqual([]);
    // With anchoring on, Chrome holds the card itself before Sifter reads it (no correction
    // needed); without it, only Sifter's scroll does, and these variants fail without it.
    if (variant.css.includes('overflow-anchor: none')) {
      const p = (await perf(context)) as unknown as { releaseCorrections: number };
      expect(p.releaseCorrections, 'the release moved the page and Sifter undid it').toBeGreaterThan(0);
    }
    await control.evaluate((m) => chrome.runtime.sendMessage(m), release.off);
    await control.close();
  });
}

test('a hidden card in a pinned rail collapses where it is, without a scroll; a feed card on screen stays veiled', async ({ context, page }) => {
  await open(page, '#rail { position: fixed; top: 120px; right: 0; width: 300px; z-index: 5; background: #fff; }');
  await insertLateAd(page);
  const RAIL = 'update-card-focus9002FeedType_MAIN_FEED_RELEVANCE';
  await page.evaluate((key) => {
    const src = document.querySelector('[componentkey^="update-card-focus1002"]') as HTMLElement;
    const clone = src.cloneNode(true) as HTMLElement;
    clone.setAttribute('componentkey', key);
    clone.removeAttribute('data-gold');
    clone.removeAttribute('style');
    for (const c of [...clone.classList]) if (c.startsWith('sifter-')) clone.classList.remove(c);
    clone.querySelector(':scope > [data-sifter-placeholder]')?.remove();
    const rail = document.createElement('div');
    rail.id = 'rail';
    rail.append(clone);
    // Inside the feed's own container, so the scanner treats it like any other unit.
    (document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement).parentElement!.parentElement!.append(rail);
  }, RAIL);
  const rail = page.locator(`[componentkey="${RAIL}"]`);
  // A rail never scrolls away: left veiled, it would be a blank hole for good.
  await expect(rail).toHaveClass(/\bsifter-collapse\b/);
  // Control: the feed card on screen got the same looks and is still veiled.
  await page.waitForTimeout(300);
  await expect(late(page)).toHaveClass(/\bsifter-veil\b/);
  const p = (await perf(context)) as unknown as { veilsPinned: number };
  expect(p.veilsPinned).toBeGreaterThan(0);
});

// LinkedIn wraps a post's content in a `display: contents` box, which clip-path cannot
// clip: the post kept painting under its Hidden bar. Screenshots of the card with a
// magenta probe shown and hidden must match while veiled, and differ once it is shown.
test('a veiled card paints nothing, even through a display: contents wrapper', async ({ page }) => {
  await open(page, `[componentkey="${LATE}"] > ._77aa { display: contents; }`);
  await insertLateAd(page);
  await page.evaluate((key) => {
    const b = document.createElement('div');
    b.id = 'paint-probe';
    b.style.cssText = 'height: 120px; background: rgb(255, 0, 255);';
    (document.querySelector(`[componentkey="${key}"] > ._77aa`) as HTMLElement).append(b);
  }, LATE);
  await expect(late(page)).toHaveClass(/\bsifter-veil\b/);
  const probe = (v: 'visible' | 'hidden') =>
    page.evaluate((v) => {
      (document.getElementById('paint-probe') as HTMLElement).style.visibility = v;
    }, v);
  const paints = async () => {
    await probe('visible');
    const on = await late(page).screenshot({ animations: 'disabled' });
    await probe('hidden');
    const off = await late(page).screenshot({ animations: 'disabled' });
    await probe('visible');
    return !on.equals(off);
  };
  expect(await paints(), 'the probe painted under the veil').toBe(false);
  await page.locator(`[componentkey="${LATE}"] > [data-sifter-placeholder] .row [data-act="show"]`).click();
  await expect(late(page)).not.toHaveClass(/\bsifter-hidden\b/);
  expect(await paints(), 'positive control: once shown, the probe paints').toBe(true);
});
