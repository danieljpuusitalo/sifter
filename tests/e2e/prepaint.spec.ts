import { expect, type Page } from '@playwright/test';
import { open, perf, test, type Arrival } from './feed';

// The pre-paint lane, end to end: a sponsored card the feed appends with its label in it
// is hidden before the browser ever draws it, so its first paint is already the bar.
//
// The oracle runs in the page's own world. While the feed scrolls, it inserts copies of
// sponsored card 1002 mid-screen from timer tasks (the way a network response lands), and
// samples every animation frame (the step right before paint): a copy connected and not
// hidden in any frame was drawn bare. The negative control inserts the same copies
// as empty shells filled a frame later, which the lane cannot see: the oracle must
// catch those being drawn, or it proves nothing.

type Run = { inserted: number; bareFrames: number; hiddenAtEnd: number; taggedAtEnd: number; shiftFrames: number };

function scrollAndInsert(page: Page, how: Arrival): Promise<Run> {
  return page.evaluate(async (how) => {
    const src = document.querySelector('[componentkey^="update-card-focus1002"]') as HTMLElement;
    const clones: HTMLElement[] = [];
    let bareFrames = 0;
    let shiftFrames = 0;
    new PerformanceObserver((list) => {
      shiftFrames += list.getEntries().length;
    }).observe({ type: 'layout-shift' });
    let running = true;
    const sample = () => {
      for (const c of clones) if (c.isConnected && !c.classList.contains('sifter-hidden')) bareFrames++;
      window.scrollBy(0, 6);
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const insert = (i: number) => {
      const clone = src.cloneNode(true) as HTMLElement;
      clone.setAttribute('componentkey', `update-card-focus95${i}FeedType_MAIN_FEED_RELEVANCE`);
      clone.removeAttribute('data-gold');
      clone.removeAttribute('style');
      for (const c of [...clone.classList]) if (c.startsWith('sifter-')) clone.classList.remove(c);
      clone.querySelector(':scope > [data-sifter-placeholder]')?.remove();
      const content = document.createDocumentFragment();
      if (how === 'filled') content.append(...clone.childNodes);
      // Mid-screen: before the first organic card whose top is past the middle.
      const cards = [...document.querySelectorAll<HTMLElement>('[componentkey^="update-card-focus"]:not(.sifter-hidden)')];
      const at = cards.find((c) => c.getBoundingClientRect().top > innerHeight / 2) ?? cards[cards.length - 1]!;
      at.before(clone);
      clones.push(clone);
      if (how === 'filled') requestAnimationFrame(() => requestAnimationFrame(() => clone.append(content)));
    };
    for (let i = 0; i < 6; i++) {
      await new Promise((done) => setTimeout(done, 120));
      insert(i);
    }
    await new Promise((done) => setTimeout(done, 300));
    running = false;
    // Wait out the debounced pass, so the late path has run too.
    await new Promise((done) => setTimeout(done, 1200));
    return {
      inserted: clones.length,
      bareFrames,
      hiddenAtEnd: clones.filter((c) => c.classList.contains('sifter-hidden')).length,
      taggedAtEnd: clones.filter((c) => c.classList.contains('sifter-tag')).length,
      shiftFrames,
    };
  }, how);
}

test('a sponsored card appended mid-scroll with its label is never drawn: hidden before its first frame', async ({ context, page }) => {
  await open(page);
  const before = await perf(context);
  const run = await scrollAndInsert(page, 'born');
  expect(run.inserted).toBe(6);
  expect(run.bareFrames, 'frames in which an inserted ad was connected and not hidden').toBe(0);
  expect(run.hiddenAtEnd, 'still hidden after the debounced pass confirmed them').toBe(6);
  // Each insertion moves the cards below it once, by the bar's height: the site's own shift,
  // in the frame it lands. A Sifter collapse would be another frame of shifts on top.
  expect(run.shiftFrames, 'layout-shift frames beyond the insertions themselves').toBeLessThanOrEqual(run.inserted);
  const after = await perf(context);
  expect(after.laneHits - before.laneHits, 'the lane hid them, not the debounced pass').toBe(6);
  expect(after.laneReleases).toBe(0);
});

test('negative control: the oracle sees a card the lane cannot catch being drawn, and that card is tagged, not moved', async ({ context, page }) => {
  await open(page);
  const before = await perf(context);
  const run = await scrollAndInsert(page, 'filled');
  expect(run.inserted).toBe(6);
  expect(run.bareFrames, 'the oracle must fail when the lane is not the one hiding').toBeGreaterThan(0);
  const after = await perf(context);
  expect(after.laneHits - before.laneHits).toBe(0);
  // Caught late, on screen: each is tagged in place (or, once far behind the reader, collapsed).
  expect(run.taggedAtEnd + run.hiddenAtEnd, 'positive control: the late path caught every one').toBe(6);
  expect(run.taggedAtEnd).toBeGreaterThan(0);
});
