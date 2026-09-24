// Renders the Chrome Web Store assets into docs/store/ from the synthetic fixtures
// only (never a live site or a real account). Needs a build first:
// `pnpm store:assets` runs `wxt build` and then this script.
//
//   screenshot-1-feed.png     1280x800  LinkedIn fixture, without vs with Sifter
//   screenshot-2-popup.png    1280x800  the popup over the LinkedIn fixture, real counts
//   screenshot-3-options.png  1280x800  the settings page
//   promo-small-440x280.png   440x280   small promo tile
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const OUT = join(ROOT, 'docs', 'store');
mkdirSync(OUT, { recursive: true });

const FIXTURES = {
  'www.linkedin.com': 'linkedin-feed.html',
};
const ICON = readFileSync(join(ROOT, 'assets', 'icon.svg'), 'utf8');
const GREEN = '#1f6f5c';
const AMBER = '#f2b544';

/** Serve the fixtures at their real URLs and abort everything else, as the e2e does. */
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

const png = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

/** Every store image is a plain HTML page rendered at its exact pixel size. */
async function stage(browser, file, width, height, body) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: ${GREEN}; color: #fff; }
    h1 { margin: 0; font-size: 40px; font-weight: 700; letter-spacing: -0.5px; }
    p.sub { margin: 8px 0 0; font-size: 20px; opacity: 0.85; }
    .shot { border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.35); display: block; background: #fff; }
    .tag { display: inline-block; font-size: 15px; font-weight: 600; padding: 4px 10px; border-radius: 999px; margin-bottom: 10px; }
  </style></head><body>${body}</body></html>`);
  await page.screenshot({ path: join(OUT, file) });
  await page.close();
  console.log(`wrote docs/store/${file}`);
}

const plain = await chromium.launch();
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 620, height: 1000 },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  await routeFixtures(context);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // The fixture's lower half holds deliberate traps (a non-post "Promoted" module,
  // an organic post reading "Ad") that the scanner correctly leaves alone. In a
  // store image they read as misses, so every feed shot is cropped above them.

  // 1. The same feed, without and with Sifter.
  const before = await plain.newPage({ viewport: { width: 620, height: 1000 }, deviceScaleFactor: 1 });
  await routeFixtures(before.context());
  await before.goto('https://www.linkedin.com/');
  const beforeShot = await before.screenshot();
  await before.close();

  const feed = await context.newPage();
  await feed.goto('https://www.linkedin.com/');
  await feed.locator('[data-sifter-placeholder]').first().waitFor();
  await feed.waitForTimeout(1500); // decisions land in idle slices
  const afterShot = await feed.screenshot();
  await feed.close();

  await stage(plain, 'screenshot-1-feed.png', 1280, 800, `
    <div style="padding:36px 48px 0">
      <h1>The ads your ad blocker misses</h1>
      <p class="sub">Sponsored posts are served by the site itself, so Sifter reads the label instead.</p>
    </div>
    <div style="display:flex;gap:40px;padding:28px 48px 0;justify-content:center">
      <div><span class="tag" style="background:rgba(255,255,255,0.18)">Without Sifter</span>
        <img class="shot" src="${png(beforeShot)}" style="width:540px;height:540px;object-fit:cover;object-position:top"></div>
      <div><span class="tag" style="background:${AMBER};color:#1b1b1b">With Sifter</span>
        <img class="shot" src="${png(afterShot)}" style="width:540px;height:540px;object-fit:cover;object-position:top"></div>
    </div>`);

  // 2. The popup, reading a real page state. A popup opened as a tab would find
  // itself as the active tab, so tabs.query is pointed at the fixture's tab.
  const li = await context.newPage();
  await li.setViewportSize({ width: 900, height: 1000 });
  await li.goto('https://www.linkedin.com/');
  await li.locator('[data-sifter-placeholder]').first().waitFor();
  await li.waitForTimeout(1500);
  const liShot = await li.screenshot();
  const [liTab] = await sw.evaluate(() => chrome.tabs.query({ url: 'https://www.linkedin.com/*' }));
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.addInitScript((tab) => {
    chrome.tabs.query = async () => [tab];
  }, { id: liTab.id, url: 'https://www.linkedin.com/' });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator('.counts').waitFor();
  const popupShot = await popup.locator('main.popup').screenshot();
  await popup.close();
  await li.close();

  await stage(plain, 'screenshot-2-popup.png', 1280, 800, `
    <div style="display:flex;height:100%">
      <div style="width:470px;padding:175px 0 0 56px">
        <h1>One click per site</h1>
        <p class="sub">See what was hidden, choose what to block on each site, or pause for an hour.</p>
        <p class="sub" style="margin-top:28px">LinkedIn, Reddit, Google, X, Instagram, Facebook and Threads, and any other site you turn on.</p>
      </div>
      <div style="position:relative;flex:1;padding-top:165px">
        <img class="shot" src="${png(liShot)}" style="width:640px;height:440px;object-fit:cover;object-position:top;opacity:0.9">
        <img class="shot" src="${png(popupShot)}" style="position:absolute;top:205px;left:420px;width:320px;outline:1px solid rgba(0,0,0,0.12)">
      </div>
    </div>`);

  // 3. The settings page.
  const options = await context.newPage();
  await options.setViewportSize({ width: 1100, height: 900 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForLoadState('networkidle');
  await options.waitForTimeout(500);
  const optionsShot = await options.screenshot();
  await options.close();

  await stage(plain, 'screenshot-3-options.png', 1280, 800, `
    <div style="padding:36px 48px 0">
      <h1>Filter lists, like an ad blocker</h1>
      <p class="sub">Sponsored, suggested and your own muted words, globally or per site. Nothing leaves your browser.</p>
    </div>
    <div style="padding:28px 0 0;display:flex;justify-content:center">
      <img class="shot" src="${png(optionsShot)}" style="width:1100px;height:640px;object-fit:cover;object-position:top">
    </div>`);

  // Small promo tile.
  await stage(plain, 'promo-small-440x280.png', 440, 280, `
    <div style="display:flex;flex-direction:column;justify-content:center;height:100%;padding:0 32px;background:#f4f2ee;color:${GREEN}">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="width:64px;height:64px">${ICON.replace('<svg ', '<svg width="64" height="64" ')}</div>
        <div style="font-size:40px;font-weight:700;letter-spacing:-0.5px">Sifter</div>
      </div>
      <div style="font-size:21px;line-height:1.3;margin-top:18px">Hides the sponsored posts your ad blocker misses.</div>
    </div>`);
} finally {
  await context.close();
  await plain.close();
}
