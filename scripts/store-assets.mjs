// Renders the Chrome Web Store assets into docs/store/ from a synthetic feed only
// (fixtures/store/feed.html: invented, generic names; never a live site or a real
// account). Needs a build first: `pnpm store:assets` runs `wxt build` and then this.
//
//   screenshot-1-feed.png     1280x800  the same feed, without vs with Sifter
//   screenshot-2-popup.png    1280x800  the popup over that feed, real counts
//   screenshot-3-options.png  1280x800  the settings page, with example muted words
//   promo-small-440x280.png   440x280   small promo tile
//   promo-marquee-1400x560.png 1400x560 marquee promo tile
//   store-icon-128x128.png    128x128   store icon (a copy of public/icon/128.png)
//
// The feed is served at the LinkedIn URL so the real LinkedIn adapter runs on it;
// it is dressed as a neutral feed, not as LinkedIn. Captures are taken at 2x and
// placed at 1x, so text stays sharp. Fonts come from Google Fonts at render time.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const OUT = join(ROOT, 'docs', 'store');
mkdirSync(OUT, { recursive: true });

const FEED_URL = 'https://www.linkedin.com/feed/';
const FEED_HTML = readFileSync(join(ROOT, 'fixtures', 'store', 'feed.html'), 'utf8');
const ICON = readFileSync(join(ROOT, 'assets', 'icon.svg'), 'utf8');
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const MUTED = ['giveaway', 'webinar', 'crypto'];

// Palette: the icon's green as ink on warm paper, amber as the one accent.
const C = { paper: '#f4f0e8', ink: '#163f35', green: '#1f6f5c', amber: '#f2b544', text: '#1d2320', muted: '#5f665f' };

/** Serve the store feed at its URL, let fonts through, abort everything else. */
async function route(context) {
  await context.route('**/*', (r) => {
    const url = new URL(r.request().url());
    if (url.protocol === 'chrome-extension:' || FONT_HOSTS.has(url.hostname)) return r.continue();
    if (url.href.startsWith(FEED_URL) && r.request().resourceType() === 'document') {
      return r.fulfill({ contentType: 'text/html', body: FEED_HTML });
    }
    return r.abort();
  });
}

const png = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const icon = (px) => ICON.replace('<svg ', `<svg width="${px}" height="${px}" `);

const GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
)}")`;

/** Every store image is a plain HTML page rendered at its exact pixel size. */
async function stage(browser, file, width, height, body, extraCss = '') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head>
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Figtree:wght@400;500;600;700&display=block" rel="stylesheet">
    <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body { font-family: 'Figtree', sans-serif; color: ${C.text}; position: relative;
      background: ${GRAIN}, radial-gradient(120% 90% at 100% 0%, #fbf8f2 0%, ${C.paper} 55%, #ece6da 100%); }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; color: ${C.ink}; letter-spacing: -0.2px; }
    h1 { margin: 0; font-family: 'Instrument Serif', serif; font-weight: 400; color: ${C.ink}; font-size: 64px; line-height: 1.02; letter-spacing: -1px; }
    h1 em { font-style: italic; color: ${C.green}; }
    .sub { margin: 14px 0 0; font-size: 21px; line-height: 1.4; color: ${C.muted}; max-width: 34ch; }
    .panel { position: absolute; border-radius: 16px; overflow: hidden; background: #efebe3;
      box-shadow: 0 1px 0 rgba(22,63,53,0.06), 0 24px 60px -18px rgba(22,63,53,0.35); }
    .panel img { display: block; }
    .panel.fade::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 40px; background: linear-gradient(rgba(239,235,227,0), #efebe3 90%); }
    .label { position: absolute; font-size: 13px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
    .label i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    ${extraCss}
  </style></head><body>${body}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUT, file) });
  await page.close();
  console.log(`wrote docs/store/${file}`);
}

/** Load the feed, wait for Sifter's decisions to land, return a 2x capture and the ad cards' boxes. */
async function captureFeed(page, { width, height, sifter }) {
  await page.setViewportSize({ width, height });
  await page.goto(FEED_URL);
  await page.evaluate(() => document.fonts.ready);
  if (sifter) {
    await page.locator('[data-sifter-placeholder]').first().waitFor();
    await page.waitForTimeout(1500); // decisions land in idle slices
  }
  const ads = await page.evaluate(() =>
    [...document.querySelectorAll('[role="listitem"]')]
      .filter((u) => u.querySelector('.hd p + p')?.textContent === 'Promoted')
      .map((u) => {
        const r = u.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );
  return { shot: await page.screenshot(), ads };
}

const plain = await chromium.launch();
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  await route(context);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // 1. The same feed, without and with Sifter. The feed renders 640 css px wide and is
  // placed at 560, so both folded ads fit the "with" panel.
  const PW = 560;
  const PH = 500;
  const K = 640 / PW;
  const beforeCtx = await plain.newContext({ deviceScaleFactor: 2 });
  await route(beforeCtx);
  const before = await captureFeed(await beforeCtx.newPage(), { width: 640, height: Math.round(PH * K), sifter: false });
  await beforeCtx.close();
  const feedPage = await context.newPage();
  const after = await captureFeed(feedPage, { width: 640, height: Math.round(PH * K), sifter: true });
  await feedPage.close();

  const rings = before.ads
    .map((a) => ({ x: a.x / K, y: a.y / K, w: a.w / K, h: a.h / K }))
    .filter((a) => a.y < PH)
    .map((a) => `<div class="ring" style="left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${Math.min(a.h, PH - a.y - 2)}px"><span>Ad</span></div>`)
    .join('');
  await stage(
    plain,
    'screenshot-1-feed.png',
    1280,
    800,
    `
    <div style="position:absolute;left:64px;top:52px" class="brand">${icon(30)} Sifter</div>
    <div style="position:absolute;left:64px;top:104px;width:1152px;display:flex;align-items:flex-end;justify-content:space-between;gap:48px">
      <h1>Sponsored posts, <em>folded away.</em></h1>
      <p class="sub" style="margin:0 0 8px;max-width:30ch;font-size:19px">Ad blockers stop ad networks. Sifter reads the label a site puts on its own ads.</p>
    </div>
    <div class="label" style="left:68px;top:226px;color:${C.muted}"><i style="background:${C.amber}"></i>Without Sifter: ${before.ads.length} ads</div>
    <div class="label" style="left:${64 + PW + 36}px;top:226px;color:${C.ink}"><i style="background:${C.green}"></i>With Sifter: folded away, one click to open</div>
    <div class="panel fade" style="left:64px;top:256px;width:${PW}px;height:${PH}px">
      <img src="${png(before.shot)}" style="width:${PW}px;height:${PH}px">${rings}
    </div>
    <div class="panel fade" style="left:${64 + PW + 32}px;top:256px;width:${PW}px;height:${PH}px">
      <img src="${png(after.shot)}" style="width:${PW}px;height:${PH}px">
    </div>`,
    `.ring { position:absolute; border:3px solid ${C.amber}; border-radius:14px; box-shadow: 0 0 0 4px rgba(242,181,68,0.25); }
     .ring span { position:absolute; top:-3px; right:-3px; background:${C.amber}; color:#3a2a05; font-weight:700; font-size:13px; padding:4px 10px; border-radius:0 12px 0 10px; }`,
  );

  // Example muted words, so the popup and the settings page show a filter at work.
  await sw.evaluate((words) => chrome.storage.local.set({ settings: { mutedWords: words } }), MUTED);

  // 2. The popup, reading a real page state. A popup opened as a tab would find
  // itself as the active tab, so tabs.query is pointed at the feed's tab.
  const feed2 = await context.newPage();
  const behind = await captureFeed(feed2, { width: 560, height: 680, sifter: true });
  const [feedTab] = await sw.evaluate((u) => chrome.tabs.query({ url: `${u}*` }), FEED_URL);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 700 });
  await popup.addInitScript((tab) => {
    chrome.tabs.query = async () => [tab];
  }, { id: feedTab.id, url: FEED_URL });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator('.counts').waitFor();
  await popup.waitForTimeout(300);
  const popupBox = await popup.locator('main.popup').boundingBox();
  const popupShot = await popup.locator('main.popup').screenshot();
  await popup.close();
  await feed2.close();

  const POPW = 368; // 1.15x of the popup's 320 css px, from a 2x capture
  const popH = Math.round((popupBox.height * POPW) / popupBox.width);
  const points = [
    ['What was hidden on this page, and why'],
    ['What to block, for each site'],
    ['Pause for an hour, or turn a site off'],
  ]
    .map(([t], i) => `<li><b>${i + 1}</b><span>${t}</span></li>`)
    .join('');
  await stage(
    plain,
    'screenshot-2-popup.png',
    1280,
    800,
    `
    <div style="position:absolute;left:64px;top:52px" class="brand">${icon(30)} Sifter</div>
    <div style="position:absolute;left:64px;top:178px;width:480px">
      <h1>One click,<br><em>per site.</em></h1>
      <ul class="pts">${points}</ul>
      <p class="sites">LinkedIn · Reddit · Google · X · Instagram · Facebook · Threads, and any site you turn on.</p>
    </div>
    <div class="panel fade" style="left:600px;top:60px;width:560px;height:680px">
      <img src="${png(behind.shot)}" style="width:560px;height:680px;opacity:0.55;filter:saturate(0.6)">
    </div>
    <img src="${png(popupShot)}" style="position:absolute;left:${1216 - POPW}px;top:${Math.max(40, Math.round((800 - popH) / 2))}px;width:${POPW}px;border-radius:14px;
      box-shadow:0 0 0 1px rgba(22,63,53,0.12), 0 30px 70px -20px rgba(22,63,53,0.55)">`,
    `.pts { list-style:none; margin:36px 0 0; padding:0; display:grid; gap:16px; }
     .pts li { display:flex; align-items:center; gap:14px; font-size:20px; font-weight:500; color:${C.text}; }
     .pts b { flex:0 0 32px; height:32px; border-radius:50%; display:grid; place-items:center; background:${C.amber}; color:#3a2a05; font-size:15px; }
     .sites { margin:36px 0 0; font-size:16px; line-height:1.5; color:${C.muted}; max-width:40ch; }`,
  );

  // 3. The settings page, at a width where each section sits at 1:1.
  const options = await context.newPage();
  await options.setViewportSize({ width: 600, height: 1600 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForLoadState('networkidle');
  await options.waitForTimeout(500);
  const section = (h) => options.locator('section', { has: options.locator('h2', { hasText: h }) }).first();
  const grab = async (h) => ({ shot: await section(h).screenshot(), box: await section(h).boundingBox() });
  const block = await grab('What to block');
  const look = await grab('How hidden posts look');
  const filters = await grab('My filters');
  await options.close();

  // Placed at 0.9 so two columns and the left column's two cards fit the frame.
  const S = 0.9;
  const card = (s, x, y) =>
    `<div class="card" style="left:${x}px;top:${y}px;width:${Math.round(s.box.width * S) + 48}px"><img src="${png(s.shot)}" style="width:${Math.round(s.box.width * S)}px"></div>`;
  const colW = Math.round(block.box.width * S) + 48;
  const lookY = 236 + Math.round(block.box.height * S) + 40 + 20;
  await stage(
    plain,
    'screenshot-3-options.png',
    1280,
    800,
    `
    <div style="position:absolute;left:64px;top:52px" class="brand">${icon(30)} Sifter</div>
    <div style="position:absolute;left:64px;top:104px;width:1152px;display:flex;align-items:flex-end;justify-content:space-between;gap:48px">
      <h1>Filter lists, <em>like an ad blocker.</em></h1>
      <p class="sub" style="margin:0 0 8px;max-width:28ch;font-size:19px">Globally or per site. Nothing leaves your browser.</p>
    </div>
    ${card(block, 64, 236)}
    ${card(look, 64, lookY)}
    ${card(filters, 64 + colW + 32, 236)}`,
    `.card { position:absolute; background:#fff; border-radius:16px; padding:20px 24px;
       box-shadow: 0 1px 0 rgba(22,63,53,0.06), 0 24px 60px -18px rgba(22,63,53,0.3); }
     .card img { display:block; }`,
  );

  // Small promo tile.
  await stage(
    plain,
    'promo-small-440x280.png',
    440,
    280,
    `
    <div class="tile"></div>
    <div style="position:absolute;left:32px;top:34px;display:flex;align-items:center;gap:14px">
      <div style="width:52px;height:52px;border-radius:12px;box-shadow:0 0 0 2px rgba(255,255,255,0.15)">${icon(52)}</div>
      <div style="font-family:'Instrument Serif',serif;font-size:50px;color:#fff;letter-spacing:-0.5px">Sifter</div>
    </div>
    <div style="position:absolute;left:32px;top:112px;width:370px;font-size:20px;line-height:1.35;color:#e8efe9">Hides the sponsored posts your ad blocker misses.</div>
    <div style="position:absolute;left:32px;right:32px;bottom:30px;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.35);color:#e8efe9;font-size:14px">
      <span style="flex:1">Hidden sponsored post</span><span style="text-decoration:underline;text-underline-offset:2px">Show</span><span style="color:${C.amber};font-weight:600">Not an ad</span>
    </div>`,
    `.tile { position:absolute; inset:0; background: ${GRAIN}, linear-gradient(150deg, #1f6f5c 0%, ${C.ink} 100%); }`,
  );

  // Marquee promo tile: the same green, with the real "with Sifter" feed from shot 1
  // running off the bottom edge.
  await stage(
    plain,
    'promo-marquee-1400x560.png',
    1400,
    560,
    `
    <div class="tile"></div>
    <div style="position:absolute;left:88px;top:112px;display:flex;align-items:center;gap:20px">
      <div style="width:76px;height:76px;border-radius:17px;box-shadow:0 0 0 2px rgba(255,255,255,0.15)">${icon(76)}</div>
      <div style="font-family:'Instrument Serif',serif;font-size:92px;line-height:1;color:#fff;letter-spacing:-1px">Sifter</div>
    </div>
    <div style="position:absolute;left:88px;top:236px;width:600px;font-family:'Instrument Serif',serif;font-size:46px;line-height:1.12;color:#fff">
      Hides the sponsored posts<br><em style="color:${C.amber}">your ad blocker misses.</em>
    </div>
    <div style="position:absolute;left:88px;top:390px;width:600px;font-size:18px;line-height:1.5;color:rgba(232,239,233,0.78)">LinkedIn · Reddit · Google · X · Instagram · Facebook · Threads</div>
    <div class="panel" style="left:${1400 - 88 - PW}px;top:${560 - PH + 4}px;width:${PW}px;height:${PH}px;border-radius:16px 16px 0 0;
      box-shadow:0 0 0 1px rgba(255,255,255,0.12), 0 30px 80px -10px rgba(0,0,0,0.45)">
      <img src="${png(after.shot)}" style="width:${PW}px;height:${PH}px">
    </div>`,
    `.tile { position:absolute; inset:0; background: ${GRAIN}, radial-gradient(90% 120% at 80% 0%, #2a7a66 0%, #1f6f5c 35%, ${C.ink} 100%); }`,
  );

  // Store icon: the 128 px manifest icon is already drawn to the store's spec (96 px of
  // artwork in 16 px of transparent padding, scripts/render-icons.mjs).
  copyFileSync(join(ROOT, 'public', 'icon', '128.png'), join(OUT, 'store-icon-128x128.png'));
  console.log('wrote docs/store/store-icon-128x128.png');
} finally {
  await context.close();
  await plain.close();
}
