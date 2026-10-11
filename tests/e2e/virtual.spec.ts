import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { driveSteps, PROBE_SCRIPT, summariseProbe, type ProbeRaw, type ProbeRow, type ProbeSummary } from '../../bench/probe';
import { settleInstall } from './install';

// Scroll stability on a virtualised feed (perf/scroll-stability, Phase 0).
//
// `fixtures/public/linkedin-virtual.html` unmounts far posts, keeps each slot at the
// height its post last measured, and re-creates the post whole when it comes back, the
// way LinkedIn's feed does. The probe (bench/probe.ts) drives the scroll itself, one
// step per frame, so it knows the intended move and measures the exact visible jump of
// every post on screen: down, back up, then reversing. The same run with the extension
// off is the fixture's own control: it must hold still, so whatever moves with Sifter
// on is Sifter's.

const EXT = resolve('.output/chrome-mv3');
const HOST = 'www.linkedin.com';
const FIXTURE = readFileSync(join('fixtures', 'public', 'linkedin-virtual.html'), 'utf8');
const UNIT = (JSON.parse(readFileSync(join('src', 'adapters', 'linkedin.json'), 'utf8')) as { unitSelector: string }).unitSelector;

const test = base.extend<{ withExt: boolean; context: BrowserContext; page: Page }>({
  withExt: [true, { option: true }],
  context: async ({ withExt }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 720 },
      args: withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [],
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.protocol === 'https:' && url.hostname === HOST && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: FIXTURE });
      }
      return route.abort();
    });
    if (withExt) {
      if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
      await settleInstall(context);
    }
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

type Run = {
  summary: ProbeSummary;
  virtual: { mounts: number; unmounts: number; remounts: number; shells: number; grew: number; loads: number };
  sifterUnits: number;
  /** Each frame where a post on screen moved, with the frame before it: numbers only, so a failure names its mechanism. */
  jumps: Array<Pick<ProbeRow, 't' | 'st' | 'v' | 'sifterAbove' | 'sifterIn' | 'sifterBelow' | 'remountJump' | 'births'>>;
};

/** Down 240 frames, back up, then 240 frames reversing, 60 px a frame with a pause each second. */
async function scrollFeed(page: Page): Promise<Run> {
  await page.evaluate(PROBE_SCRIPT);
  await page.evaluate((unitSelector) => {
    (window as unknown as { __sifterProbe: { start(c: unknown): void } }).__sifterProbe.start({ unitSelector, scrollerSelector: '#workspace' });
  }, UNIT);
  const drive = (steps: number[]) =>
    page.evaluate((s) => (window as unknown as { __sifterProbe: { drive(s: number[]): Promise<void> } }).__sifterProbe.drive(s), steps);
  await drive(driveSteps('down', 240, 60));
  await page.waitForTimeout(600);
  await drive(driveSteps('up', 240, 60));
  await page.waitForTimeout(600);
  await drive(driveSteps('reverse', 240, 60));
  const raw = await page.evaluate(() => (window as unknown as { __sifterProbe: { stop(): ProbeRaw } }).__sifterProbe.stop());
  const pick = (r: ProbeRow) => ({ t: r.t, st: r.st, v: r.v, sifterAbove: r.sifterAbove, sifterIn: r.sifterIn, sifterBelow: r.sifterBelow, remountJump: r.remountJump, births: r.births });
  const jumps = raw.rows.flatMap((r, i) => (r.v !== null && !r.clamp && Math.abs(r.v) > 1 ? [raw.rows[i - 1] ?? r, r].map(pick) : []));
  return {
    jumps,
    summary: summariseProbe(raw)!,
    virtual: await page.evaluate(() => (window as unknown as { __virtual: Run['virtual'] }).__virtual),
    sifterUnits: await page.evaluate(() => document.querySelectorAll('.sifter-hidden, .sifter-tag').length),
  };
}

async function open(page: Page, withExt: boolean): Promise<void> {
  await page.goto(`https://${HOST}/`);
  if (withExt) await expect(page.locator('[componentkey^="update-card-focus2002"]')).toHaveClass(/\bsifter-(hidden|tag)\b/);
  await page.waitForTimeout(500);
}

/** Counts only, for the run's receipt. */
const receipt = (label: string, r: Run) =>
  console.log(
    `[virtual] ${label}: ${JSON.stringify({
      visible: r.summary.visible,
      relative: r.summary.relative,
      clamps: r.summary.clamps,
      distance: r.summary.distance,
      remounts: r.summary.remounts,
      sifterChanges: r.summary.sifterChanges,
      virtual: r.virtual,
      sifterUnits: r.sifterUnits,
      jumps: r.jumps,
    })}`,
  );

test.describe('virtualised feed, extension off (the fixture holds still on its own)', () => {
  test.use({ withExt: false });
  test('no post on screen jumps while scrolling down, up and reversing', async ({ page }) => {
    await open(page, false);
    const run = await scrollFeed(page);
    receipt('off', run);
    expect(run.summary.distance.down, 'positive control: it scrolled down').toBeGreaterThan(8000);
    expect(run.summary.distance.up, 'positive control: and back up').toBeGreaterThan(8000);
    expect(run.virtual.remounts, 'positive control: the site re-mounted posts').toBeGreaterThan(0);
    expect(run.virtual.loads, 'positive control: the sentinel loaded more').toBeGreaterThan(0);
    expect(run.summary.visible.measured).toBeGreaterThan(300);
    expect(run.summary.visible.site.frames + run.summary.visible.sifter.frames, 'visible jumps with Sifter off').toBe(0);
  });
});

test.describe('virtualised feed, extension on', () => {
  test('Sifter makes no post on screen jump while scrolling down, up and reversing', async ({ page }) => {
    await open(page, true);
    const run = await scrollFeed(page);
    receipt('on', run);
    expect(run.sifterUnits, 'positive control: Sifter hid or tagged posts').toBeGreaterThan(0);
    expect(run.summary.remounts.n, 'positive control: the probe saw re-mounts').toBeGreaterThan(0);
    expect(run.virtual.remounts).toBeGreaterThan(0);
    expect(run.summary.visible.measured).toBeGreaterThan(300);
    // No jump allowed. Until mount memory (Phase 1, 2026-10-11) an ad Sifter had collapsed
    // far below came back on the way up whole, as a shell the lane could not read yet or a
    // unit its 1 ms cap cut, into a slot the site kept at the collapsed height: one frame,
    // +256 to +414 px, remountJump=1. Once a run on this laptop, two to five on CI's macOS.
    // Both buckets: the off-run holds still on the same steps, so any jump here is Sifter's,
    // and blame (a time window) can miss a change made frames earlier. A fix that only moves
    // a jump into the site bucket must not pass.
    const { sifter, site } = run.summary.visible;
    const moved = run.jumps.filter((j) => j.v !== null && Math.abs(j.v) > 1);
    expect(site, 'visible jumps with Sifter on, site bucket').toEqual({ frames: 0, px: 0, max: 0 });
    expect(sifter, `visible jumps with Sifter on, sifter bucket: ${JSON.stringify(moved)}`).toEqual({ frames: 0, px: 0, max: 0 });
  });
});
