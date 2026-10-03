import { expect } from '@playwright/test';
import { HOST, SCROLLERS, fromPopup, insertCard, insertLateAd, late, LATE, open, perf, scrollPos, test, topOf, watchShifts } from './feed';

// The feed must never move under the reader when Sifter hides something.
//
// A card that arrives with its label is hidden before it paints (tests/e2e/prepaint.spec.ts).
// One whose label comes later may already be on screen: Sifter tags it in place, with a
// zero-height "Sponsored · Hide" bar over its top, and collapses it only once the reader
// has left it a full screen behind, where nothing they can see moves. A tag the reader
// scrolls past upwards stays a tag: Sifter never collapses or scrolls above the reader.

test('a sponsored card caught on screen is tagged in place: nothing moves, and Hide collapses it', async ({ context, page }) => {
  await open(page);
  const { top: before, bareAtFirstFrame } = await insertLateAd(page, 'filled');
  expect(bareAtFirstFrame, 'its shell painted before its label arrived: the late path').toBe(true);
  const moves = await watchShifts(page);
  await expect(late(page)).toHaveClass(/\bsifter-tag\b/);
  await page.waitForTimeout(600);
  // Geometry first: the classes below say how it held still, this says whether it did.
  expect(Math.abs((await topOf(page, '[componentkey^="update-card-focus1005"]')) - before)).toBeLessThanOrEqual(1);
  expect(await moves()).toEqual([]);
  await expect(late(page), 'tagged, not hidden, while on screen').not.toHaveClass(/\bsifter-hidden\b/);
  expect((await perf(context)).lateInView).toBeGreaterThan(0);
  // The bar sits over the card's top (its host is zero-height; the row overflows it), and a real click reaches it.
  const row = page.locator(`[componentkey="${LATE}"] > [data-sifter-placeholder] .row`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Sponsored');
  await row.locator('[data-act="hide-tag"]').click();
  await expect(late(page)).toHaveClass(/\bsifter-hidden\b/);
  await expect(late(page)).not.toHaveClass(/\bsifter-tag\b/);
  // One click on Show brings it back.
  await row.locator('[data-act="show"]').click();
  await expect(late(page)).not.toHaveClass(/\bsifter-hidden\b/);
});

test('a tag the reader leaves a full screen behind collapses', async ({ context, page }) => {
  // A tall first card, so the top of the feed is more than two screens above the late card.
  await open(page, '[componentkey^="update-card-focus1001"] { min-height: 1800px; }');
  await insertLateAd(page, 'filled');
  await expect(late(page)).toHaveClass(/\bsifter-tag\b/);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  const top = await topOf(page, `[componentkey="${LATE}"]`);
  expect(top, 'positive control: the late card is now two screens below').toBeGreaterThanOrEqual(2 * 720);
  await expect(late(page)).toHaveClass(/\bsifter-collapse\b/);
  await expect(late(page)).not.toHaveClass(/\bsifter-tag\b/);
  expect((await perf(context)).tagsCollapsed).toBeGreaterThan(0);
});

for (const variant of SCROLLERS) {
  test(`a tag the reader scrolls past stays a tag: nothing moves and Sifter never scrolls (${variant.name})`, async ({ context, page }) => {
    await open(page, variant.css);
    await insertLateAd(page, 'filled');
    await expect(late(page)).toHaveClass(/\bsifter-tag\b/);
    // Let the tracker take its first look before the page scrolls.
    await page.waitForTimeout(300);
    const moves = await watchShifts(page);
    const scrollBy = (dy: number | 'past') =>
      page.evaluate(
        ([dy, key]) => {
          const main = document.getElementById('workspace') as HTMLElement;
          const inElement = getComputedStyle(main).overflowY === 'auto';
          const clipTop = inElement ? main.getBoundingClientRect().top : 0;
          const card = document.querySelector(`[componentkey="${key}"]`) as HTMLElement;
          const by = dy === 'past' ? card.getBoundingClientRect().bottom - clipTop + 200 : dy;
          (inElement ? main : window).scrollBy(0, by);
          return (document.querySelector('[componentkey^="update-card-focus1005"]') as HTMLElement).getBoundingClientRect().top;
        },
        [dy, LATE] as const,
      );
    // Its top (and its bar) under the header or the clipped edge, most of it still on screen.
    await scrollBy(150);
    await page.waitForTimeout(400);
    await expect(late(page)).toHaveClass(/\bsifter-tag\b/);
    // Then on, well past it.
    const before = await scrollBy('past');
    const pos = await scrollPos(page);
    await page.waitForTimeout(800);
    await expect(late(page)).toHaveClass(/\bsifter-tag\b/);
    await expect(late(page)).not.toHaveClass(/\bsifter-collapse\b/);
    const after = await topOf(page, '[componentkey^="update-card-focus1005"]');
    expect(Math.abs(after - before), `the card below moved from ${before} to ${after}`).toBeLessThanOrEqual(1);
    expect(await scrollPos(page), 'Sifter scrolled the feed').toBe(pos);
    expect(await moves()).toEqual([]);
    // Positive control: the late card was caught on screen, by the late path.
    const p = await perf(context);
    expect(p.lateInView).toBeGreaterThan(0);
    expect(p.tagsCollapsed).toBe(0);
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
    await fromPopup(context, release.on);
    await expect(hidden).not.toHaveClass(/\bsifter-hidden\b/);
    await page.waitForTimeout(300);
    const after = await topOf(page, `[componentkey="${ref.key}"]`);
    expect(Math.abs(after - before), `${ref.key} moved from ${before} to ${after}`).toBeLessThanOrEqual(1);
    expect(await moves()).toEqual([]);
    // With anchoring on, Chrome holds the card itself before Sifter reads it (no correction
    // needed); without it, only Sifter's scroll does, and these variants fail without it.
    if (variant.css.includes('overflow-anchor: none')) {
      expect((await perf(context)).releaseCorrections, 'the release moved the page and Sifter undid it').toBeGreaterThan(0);
    }
    await fromPopup(context, release.off);
  });
}

test('a tag in a pinned rail collapses where it is, without a scroll; a feed card on screen stays tagged', async ({ context, page }) => {
  await open(page, '#rail { position: fixed; top: 120px; right: 0; width: 300px; z-index: 5; background: #fff; }');
  await insertLateAd(page, 'filled');
  const RAIL = 'update-card-focus9002FeedType_MAIN_FEED_RELEVANCE';
  await insertCard(page, RAIL, 'filled', 'rail');
  const rail = page.locator(`[componentkey="${RAIL}"]`);
  // A rail never scrolls away: left tagged, its ad would stay in view for good.
  await expect(rail).toHaveClass(/\bsifter-collapse\b/);
  // Control: the feed card on screen got the same looks and is still tagged.
  await page.waitForTimeout(300);
  await expect(late(page)).toHaveClass(/\bsifter-tag\b/);
  expect((await perf(context)).railCollapsed).toBeGreaterThan(0);
});
