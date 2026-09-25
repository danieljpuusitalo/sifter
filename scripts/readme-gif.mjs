// Renders docs/readme.gif from the synthetic LinkedIn fixture (never a live site):
// the feed without Sifter, then with Sifter, a scroll past the placeholders, and a
// click on "Show". Needs a build first: `pnpm readme:gif` runs `wxt build` and then
// this script. Needs `ffmpeg` on PATH.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const OUT = join(ROOT, 'docs', 'readme.gif');
const WIDTH = 620;
const HEIGHT = 560;
const FPS = 10;

const FIXTURES = { 'www.linkedin.com': 'linkedin-feed.html' };

async function routeFixtures(context) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    const file = FIXTURES[url.hostname];
    if (url.protocol === 'https:' && file && route.request().resourceType() === 'document') {
      return route.fulfill({ contentType: 'text/html', body: readFileSync(join(ROOT, 'fixtures', 'public', file), 'utf8') });
    }
    return route.abort();
  });
}

/** A fixed caption bar drawn by the script into the fixture page (not by the extension). */
async function caption(page, text, accent) {
  await page.evaluate(
    ({ text, accent }) => {
      let bar = document.getElementById('gif-caption');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gif-caption';
        bar.style.cssText =
          'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;' +
          "font:600 15px 'Segoe UI',system-ui,sans-serif;color:#fff;letter-spacing:0.1px";
        document.body.append(bar);
        document.body.style.paddingTop = '44px';
      }
      bar.textContent = text;
      bar.style.background = accent;
    },
    { text, accent },
  );
}

const frames = [];
const dir = mkdtempSync(join(tmpdir(), 'sifter-gif-'));
let n = 0;
async function frame(page, holdSeconds) {
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  const count = Math.max(1, Math.round(holdSeconds * FPS));
  for (let i = 0; i < count; i++) {
    const file = join(dir, `f${String(n++).padStart(4, '0')}.png`);
    writeFileSync(file, buf);
    frames.push(file);
  }
}

const GREEN = '#1f6f5c';
const GREY = '#5b5b5b';

const plain = await chromium.launch();
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  await routeFixtures(context);
  if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');

  // 1. Without Sifter: the feed as the site serves it, one sponsored post in view.
  const before = await plain.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await routeFixtures(before.context());
  await before.goto('https://www.linkedin.com/');
  await caption(before, 'Without Sifter: a sponsored post in the feed', GREY);
  await frame(before, 2.2);
  await before.close();

  // 2. With Sifter: the same feed, the sponsored post collapsed to a placeholder.
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/');
  await page.locator('[data-sifter-placeholder]').first().waitFor();
  await page.waitForTimeout(1500); // decisions land in idle slices
  await caption(page, 'With Sifter: collapsed to one line, nothing deleted', GREEN);
  await frame(page, 2.2);

  // 3. A short scroll, so the page reads as live. The fixture's lower half holds
  // deliberate traps the scanner correctly leaves alone (a non-post "Promoted"
  // module, an organic post reading "Ad"); in a GIF they read as misses, so the
  // scroll stops well above them.
  for (let y = 0; y <= 120; y += 20) {
    await page.evaluate((top) => window.scrollTo({ top }), y);
    await page.waitForTimeout(40);
    await frame(page, 1 / FPS);
  }
  await frame(page, 0.8);

  // 4. "Show" on the first visible placeholder brings the post back.
  await caption(page, 'Every hide is one click to undo', GREEN);
  await frame(page, 0.8);
  const host = page.locator('[data-sifter-placeholder]').first();
  await host.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(100);
  await frame(page, 0.6);
  await host.locator('[data-act="show"]').click();
  await page.waitForTimeout(150);
  await frame(page, 2.4);
  await page.close();
} finally {
  await context.close();
  await plain.close();
}

// Two-pass ffmpeg: a shared palette keeps the text crisp at a small file size.
mkdirSync(join(ROOT, 'docs'), { recursive: true });
const palette = join(dir, 'palette.png');
const input = ['-framerate', String(FPS), '-i', join(dir, 'f%04d.png')];
execFileSync('ffmpeg', ['-y', ...input, '-vf', 'palettegen=max_colors=128:stats_mode=diff', palette], { stdio: 'ignore' });
execFileSync(
  'ffmpeg',
  ['-y', ...input, '-i', palette, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', OUT],
  { stdio: 'ignore' },
);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote docs/readme.gif (${frames.length} frames at ${FPS} fps, ${WIDTH}x${HEIGHT})`);
