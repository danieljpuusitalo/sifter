import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import type { ScanPerf } from '../../src/messages';
import { settleInstall } from './install';

// The LinkedIn fixture served at its real URL with the built extension loaded, and the
// helpers the feed-stability specs share: insert a card the way a feed does, watch for
// layout shifts, read the scanner's counters.

const EXT = resolve('.output/chrome-mv3');
export const HOST = 'www.linkedin.com';
const FIXTURE = readFileSync(join('fixtures', 'public', 'linkedin-feed.html'), 'utf8');
const PATH = /<meta\s+name="sifter-path"\s+content="([^"]+)"/.exec(FIXTURE)?.[1] ?? '/';

export const test = base.extend<{ context: BrowserContext; page: Page }>({
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

export const CARD = '[componentkey^="update-card-focus"]';
/** The late card the specs insert above organic card 1005. */
export const LATE = 'update-card-focus9001FeedType_MAIN_FEED_RELEVANCE';
export const late = (page: Page) => page.locator(`[componentkey="${LATE}"]`);

/** Load the feed with tall cards (a real feed's are), wait for the first hides to land and settle. */
export async function open(page: Page, css = ''): Promise<void> {
  await page.goto(`https://${HOST}${PATH}`);
  await page.addStyleTag({ content: `${CARD} { min-height: 300px; box-sizing: border-box; } ${css}` });
  await expect(page.locator('[componentkey^="update-card-focus1004"]')).toHaveClass(/\bsifter-hidden\b/);
  await page.waitForTimeout(500);
}

/**
 * How a feed adds a card. `born`: the card arrives with its "Promoted" label in it, in one
 * mutation (the pre-paint lane's case). `filled`: an empty shell arrives first and paints,
 * and its content follows a frame later (the lane cannot see it: it may already be on screen).
 */
export type Arrival = 'born' | 'filled';

/**
 * Insert a copy of sponsored card 1002 under `key`: right above organic card 1005, or into
 * a new `#rail` box beside the feed. Resolves once the insertion (and any fill) has painted.
 * `bareAtFirstFrame`: the copy was connected and not hidden in the first animation frame
 * after it arrived, so the browser drew it.
 */
export function insertCard(page: Page, key: string, how: Arrival, where: 'feed' | 'rail' = 'feed'): Promise<{ bareAtFirstFrame: boolean }> {
  return page.evaluate(
    async ([key, how, where]) => {
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
      const src = document.querySelector('[componentkey^="update-card-focus1002"]') as HTMLElement;
      const ref = document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement;
      const clone = src.cloneNode(true) as HTMLElement;
      clone.setAttribute('componentkey', key);
      clone.removeAttribute('data-gold');
      clone.removeAttribute('style');
      for (const c of [...clone.classList]) if (c.startsWith('sifter-')) clone.classList.remove(c);
      clone.querySelector(':scope > [data-sifter-placeholder]')?.remove();
      const content = document.createDocumentFragment();
      if (how === 'filled') content.append(...clone.childNodes);
      if (where === 'rail') {
        const rail = document.createElement('div');
        rail.id = 'rail';
        rail.append(clone);
        // Inside the feed's own container, so the scanner treats it like any other unit.
        ref.parentElement!.parentElement!.append(rail);
      } else {
        ref.before(clone);
      }
      await frame();
      const bareAtFirstFrame = clone.isConnected && !clone.classList.contains('sifter-hidden');
      if (how === 'filled') {
        await frame();
        clone.append(content);
      }
      // Let it paint, so the insertion's own layout shift lands before anyone watches for Sifter's.
      await frame();
      await frame();
      return { bareAtFirstFrame };
    },
    [key, how, where] as const,
  );
}

/** Scroll organic card 1005 near the top of the screen, then insert the late card above it. Returns 1005's top afterwards. */
export async function insertLateAd(page: Page, how: Arrival): Promise<{ top: number; bareAtFirstFrame: boolean }> {
  await page.evaluate(() => {
    const ref = document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement;
    const main = document.getElementById('workspace') as HTMLElement;
    const inElement = getComputedStyle(main).overflowY === 'auto';
    const clipTop = inElement ? main.getBoundingClientRect().top : 0;
    (inElement ? main : window).scrollBy(0, ref.getBoundingClientRect().top - clipTop - 100);
  });
  await page.waitForTimeout(500);
  const { bareAtFirstFrame } = await insertCard(page, LATE, how);
  return { top: await topOf(page, '[componentkey^="update-card-focus1005"]'), bareAtFirstFrame };
}

/** Layout shifts from now on that moved anything on screen, in px (scrolls are not shifts). */
export async function watchShifts(page: Page): Promise<() => Promise<number[]>> {
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
export const perf = (context: BrowserContext) =>
  context.serviceWorkers()[0]!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    const state = (await chrome.tabs.sendMessage(tabs[0]!.id!, { type: 'sifter:getPageState' })) as { perf: ScanPerf };
    return state.perf;
  });

/** Send a message from an extension page, the way the popup does. */
export async function fromPopup(context: BrowserContext, message: unknown): Promise<void> {
  const [sw] = context.serviceWorkers();
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(sw!.url()).host}/popup.html`);
  await control.evaluate((m) => chrome.runtime.sendMessage(m), message);
  await control.close();
}

export const topOf = (page: Page, sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().top, sel);

/** The feed's scroll position: the window's, or `#workspace`'s where it scrolls itself. */
export const scrollPos = (page: Page) =>
  page.evaluate(() => {
    const main = document.getElementById('workspace') as HTMLElement;
    return getComputedStyle(main).overflowY === 'auto' ? main.scrollTop : scrollY;
  });

// Where the feed scrolls, and how far down its visible area starts.
export const SCROLLERS = [
  { name: 'the page, overflow-anchor: auto', css: '' },
  { name: 'the page, overflow-anchor: none', css: 'html, body { overflow-anchor: none; }' },
  // LinkedIn's shape: the feed scrolls inside <main>, whose top edge sits under a header
  // (and, measured live, Chrome does not anchor its collapses there).
  {
    name: 'an element clipped under a header, no anchoring',
    css: 'html, body { height: 100%; margin: 0; overflow: hidden; } #workspace { position: fixed; top: 100px; bottom: 0; left: 0; right: 0; overflow-y: auto; overflow-anchor: none; }',
  },
] as const;
