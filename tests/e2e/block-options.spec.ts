import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { settleInstall } from './install';

// Proves, through the real extension (service worker + content script + the same
// messages the popup sends), that every "Block on this site" switch in
// entrypoints/popup/App.tsx works both ON and OFF, on every site fixture: the
// category switches (sponsored, suggested), every per-site suggested rule, the
// site enable switch, and the custom filters switch (muted words / element rules).

// The service worker's `chrome` global, as far as these tests use it (the code runs
// inside the extension via sw.evaluate, not in Node); and the page's `chrome` global
// for sending BgRequest from an extension page (popup.html), as the popup does.
declare const chrome: {
  storage: { local: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> } };
  tabs: {
    query(q: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

type RuleState = { id: string; label: string; on: boolean };
type PageState = {
  siteKey: string;
  enabled: boolean;
  counts: Partial<Record<string, number>>;
  categories: Record<string, boolean>;
  canSuggest: boolean;
  rules: RuleState[];
  hiddenNow: number;
  settled: boolean;
};

const EXT = resolve('.output/chrome-mv3');

/**
 * `sifter:refresh` re-decides every unit and answers with the page state, but it
 * caps its wait at 1 s so a slow page can never hang the popup (SETTLE_CAP_MS in
 * entrypoints/content.ts). On a loaded CI runner the idle slices can take longer
 * than that, and the reply is then a mid-scan snapshot: a real count, just not the
 * final one. Poll until the scanner reports `settled`, so every assertion below
 * reads the finished state and never a race.
 */
async function refreshSettled(sw: { evaluate: <R, A>(fn: (a: A) => Promise<R>, a: A) => Promise<R> }, host: string): Promise<PageState> {
  const url = `https://${host}/*`;
  const tab = (type: string) =>
    sw.evaluate(
      async ({ u, t }) => {
        const tabs = await chrome.tabs.query({ url: u });
        return chrome.tabs.sendMessage(tabs[0]!.id!, { type: t });
      },
      { u: url, t: type },
    ) as Promise<PageState>;
  let state = await tab('sifter:refresh');
  const deadline = Date.now() + 10_000;
  while (!state.settled && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    state = await tab('sifter:getPageState');
  }
  expect(state.settled, `${host}: scanner never settled after a refresh`).toBe(true);
  return state;
}
const FIXTURES: Record<string, string> = {
  'www.linkedin.com': 'linkedin-feed.html',
  'www.google.com': 'google-search.html',
  'www.reddit.com': 'reddit-home.html',
  'x.com': 'x-home.html',
  'www.instagram.com': 'instagram-feed.html',
  'www.facebook.com': 'facebook-feed.html',
  'www.threads.com': 'threads-feed.html',
};

/** The adapter's own named suggested rules, per site (empty where the adapter has none). */
const RULE_IDS: Record<string, string[]> = {
  'www.linkedin.com': ['activity', 'follow', 'suggested'],
  'www.google.com': [],
  'www.reddit.com': [],
  'x.com': [],
  'www.instagram.com': ['accounts', 'people'],
  'www.facebook.com': ['groups', 'follow', 'reels', 'stories'],
  'www.threads.com': [],
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

/** A gold-labelled unit's current hidden state, in document order (stable across a fixture). */
type GoldSnapshot = { gold: string; hidden: boolean }[];

async function snapshot(page: Page): Promise<GoldSnapshot> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-gold]')).map((el) => ({
      gold: el.getAttribute('data-gold')!,
      hidden: el.classList.contains('sifter-hidden'),
    })),
  );
}

/** Units that went from hidden to shown between two snapshots taken in the same fixture. */
function released(before: GoldSnapshot, after: GoldSnapshot): GoldSnapshot {
  return before.filter((b, i) => b.hidden && !after[i]!.hidden).map((b) => ({ gold: b.gold, hidden: false }));
}

test.describe('Block on this site: every switch, every site', () => {
  for (const [host, file] of Object.entries(FIXTURES)) {
    test(`${host} (${file}): sponsored, suggested, every rule, site enable`, async ({ context, page }) => {
      await page.goto(`https://${host}/`);
      // The initial full scan at document_idle races the first bg call below; give it
      // a chance to converge first, the way every hide.spec.ts test does, so the
      // matrix starts from a real baseline rather than a half-scanned page.
      await expect(page.locator('.sifter-hidden').first(), file).toBeAttached();
      const [sw] = context.serviceWorkers();
      const control = await context.newPage();
      const controlId = new URL(sw!.url()).host;
      await control.goto(`chrome-extension://${controlId}/popup.html`);

      // BgRequest, sent from an extension page (as the popup does): authorize() trusts
      // any message from an extension page and takes the hostname from the message.
      const bg = (msg: Record<string, unknown>) => control.evaluate((m) => chrome.runtime.sendMessage(m), msg);

      // TabRequest, sent to this fixture's tab, as the service worker relays it for the
      // popup: the action and the (settled) read in one.
      const refresh = (): Promise<PageState> => refreshSettled(sw!, host);

      const ruleIds = RULE_IDS[host]!;

      // 1. Baseline: sponsored on (default), suggested on (off by default, so turn it on).
      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'suggested', value: true });
      let state = await refresh();
      expect(state.hiddenNow, 'baseline hiddenNow').toBeGreaterThan(0);
      expect(state.rules.map((r) => r.id).sort()).toEqual([...ruleIds].sort());
      for (const r of state.rules) expect(r.on, `rule ${r.id} on at baseline`).toBe(true);

      const baselineHiddenNow = state.hiddenNow;
      const baselineSnapshot = await snapshot(page);
      expect(baselineSnapshot.some((u) => u.gold === 'sponsored' && u.hidden), 'a sponsored unit is hidden at baseline').toBe(true);

      // 2. Sponsored off, then on.
      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'sponsored', value: false });
      state = await refresh();
      expect(state.counts['sponsored'] ?? 0, 'sponsored off: counts.sponsored').toBe(0);
      let snap = await snapshot(page);
      expect(
        snap.filter((u) => u.gold === 'sponsored' && u.hidden),
        'sponsored off: no sponsored unit stays hidden',
      ).toEqual([]);

      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'sponsored', value: true });
      state = await refresh();
      expect(state.hiddenNow, 'sponsored back on: hiddenNow returns to baseline').toBe(baselineHiddenNow);
      snap = await snapshot(page);
      expect(snap, 'sponsored back on: DOM matches baseline').toEqual(baselineSnapshot);

      // 3. Suggested off, then on.
      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'suggested', value: false });
      state = await refresh();
      expect(state.counts['suggested'] ?? 0, 'suggested off: counts.suggested').toBe(0);
      snap = await snapshot(page);
      expect(
        snap.filter((u) => u.gold === 'suggested' && u.hidden),
        'suggested off: no suggested unit stays hidden',
      ).toEqual([]);

      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'suggested', value: true });
      state = await refresh();
      expect(state.hiddenNow, 'suggested back on: hiddenNow returns to baseline').toBe(baselineHiddenNow);
      snap = await snapshot(page);
      expect(snap, 'suggested back on: DOM matches baseline').toEqual(baselineSnapshot);

      // 4. Every named suggested rule, off then on.
      for (const rule of ruleIds) {
        await bg({ type: 'sifter:setSiteRule', hostname: host, rule, value: false });
        state = await refresh();
        const ruleOff = state.rules.find((r) => r.id === rule);
        expect(ruleOff?.on, `rule ${rule} off: reported off`).toBe(false);
        expect(state.hiddenNow, `rule ${rule} off: hiddenNow drops below baseline`).toBeLessThan(baselineHiddenNow);
        snap = await snapshot(page);
        const freed = released(baselineSnapshot, snap);
        expect(freed.length, `rule ${rule} off: releases at least one unit`).toBeGreaterThan(0);
        for (const u of freed) expect(u.gold, `rule ${rule} off: every released unit is a suggested unit`).toBe('suggested');

        await bg({ type: 'sifter:setSiteRule', hostname: host, rule, value: true });
        state = await refresh();
        const ruleOn = state.rules.find((r) => r.id === rule);
        expect(ruleOn?.on, `rule ${rule} back on: reported on`).toBe(true);
        expect(state.hiddenNow, `rule ${rule} back on: hiddenNow returns to baseline`).toBe(baselineHiddenNow);
        snap = await snapshot(page);
        expect(snap, `rule ${rule} back on: DOM matches baseline`).toEqual(baselineSnapshot);
      }

      // 5. Site off, then on.
      await bg({ type: 'sifter:setSiteEnabled', hostname: host, enabled: false });
      state = await refresh();
      expect(state.hiddenNow, 'site off: hiddenNow is 0').toBe(0);
      await expect(page.locator('.sifter-hidden'), 'site off: nothing stays hidden in the DOM').toHaveCount(0);

      await bg({ type: 'sifter:setSiteEnabled', hostname: host, enabled: true });
      state = await refresh();
      expect(state.hiddenNow, 'site back on: hiddenNow returns to baseline').toBe(baselineHiddenNow);
      snap = await snapshot(page);
      expect(snap, 'site back on: DOM matches baseline').toEqual(baselineSnapshot);

      await control.close();
    });
  }

  // Custom (muted words): LinkedIn only. "copywriting" appears only in the visible
  // text of unit 1001 (data-gold="none"): "...even more careful copywriting."
  test('www.linkedin.com: custom filters (muted words) switch on and off', async ({ context, page }) => {
    const host = 'www.linkedin.com';
    await page.goto(`https://${host}/`);
    const [sw] = context.serviceWorkers();
    const control = await context.newPage();
    const controlId = new URL(sw!.url()).host;
    await control.goto(`chrome-extension://${controlId}/popup.html`);
    const bg = (msg: Record<string, unknown>) => control.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const refresh = (): Promise<PageState> => refreshSettled(sw!, host);

    const targetIsHidden = () =>
      page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[data-gold="none"]')).find((n) => (n.textContent ?? '').includes('copywriting'));
        return el?.classList.contains('sifter-hidden') ?? null;
      });

    try {
      await bg({ type: 'sifter:setFilters', mutedWords: ['copywriting'], rulesText: '' });
      let state = await refresh();
      expect(await targetIsHidden(), 'muted word hides its unit').toBe(true);
      expect(state.counts['custom'] ?? 0, 'counts.custom is 1').toBe(1);

      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'custom', value: false });
      await refresh();
      expect(await targetIsHidden(), 'custom off: unit is released').toBe(false);

      await bg({ type: 'sifter:setSiteCategory', hostname: host, category: 'custom', value: true });
      await refresh();
      expect(await targetIsHidden(), 'custom back on: unit is hidden again').toBe(true);
    } finally {
      await bg({ type: 'sifter:setFilters', mutedWords: [], rulesText: '' });
      await refresh();
      await control.close();
    }
  });
});
