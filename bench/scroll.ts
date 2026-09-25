import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';
import type { PageState } from '../src/messages';

// Scroll benchmark (hard rule 7: the extension must not cost frames).
//
// Serves a synthetic feed at the real site URL (all other network aborted, like
// the e2e tests), then scrolls it the way a person does on a long session: the
// feed already holds `--start` cards, more are appended as the bottom nears, and
// the site keeps rewriting small text ("3m", reaction counts) in cards all the
// time. Runs the same scroll with the extension off and on, and reports frame
// intervals, long tasks and the scanner's own counters.
//
//   pnpm bench:scroll [--site linkedin|facebook] [--start 150] [--seconds 15] [--runs 2] [--cpu 4] [--strict]
//
// `--site facebook` adds a right-hand rail with a sponsored module, so the
// anchored block rules (the `:has()` selectors) are on the path too.
// `--strict` exits 1 when the on-run breaks the budget (CI gate); without it the
// verdict is printed and the exit code stays 0, because headless frame timings
// are noisy. Compare off vs on in the same run, and trust the scanner's self-time
// (scanMs, maxSliceScroll) over small fps gaps.
//
// Needs a build (.output/chrome-mv3); the package script runs `wxt build` first.

declare const chrome: {
  tabs: {
    query(q: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const strArg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? String(process.argv[i + 1]) : dflt;
};
const START = arg('start', 150);
const SECONDS = arg('seconds', 15);
const RUNS = arg('runs', 2);
/** CPU slowdown (DevTools throttling). This laptop is fast; most users' machines are not. */
const CPU = arg('cpu', 4);
const SITE = strArg('site', 'linkedin');
const STRICT = process.argv.includes('--strict');
const EXT = resolve('.output/chrome-mv3');

/**
 * Budget the on-run must meet under `--strict`. The slice limit is hard rule 7's
 * 8 ms with the scanner's own 1.5x tolerance, in real time: under CPU throttling
 * it scales with the throttle, and the scanner's unscaled `slicesOverBudget`
 * counter is reported but only judged at `--cpu 1`. On this laptop the bench
 * runs emulated x64 Chromium, whose off-runs already show 10 ms spikes at 4x.
 */
const LIMITS = { maxSliceScrollMs: 12 * CPU, extraLongTasks: 1 };

type Site = { host: string; url: string; html: () => string };

const WORDS = 'the team shipped a new release today with careful testing and thanks to everyone who helped along the way'.split(' ');

/** Shared page scaffolding: the churn interval and the rAF-driven scroll loop. */
function benchScript(cardFn: string): string {
  return `
    const words = ${JSON.stringify(WORDS)};
    let n = 0;
    ${cardFn}
    function append(k) { const f = document.createDocumentFragment(); for (let j = 0; j < k; j++) f.append(card()); feed.append(f); }
    append(${START});

    // Site churn: live counters in random cards, twice a second.
    setInterval(() => {
      const cnt = document.getElementsByClassName('_cnt');
      for (let j = 0; j < 15; j++) { const el = cnt[(Math.random() * cnt.length) | 0]; if (el) el.textContent = String(Number(el.textContent) + 1); }
    }, 500);

    window.__bench = (seconds) => new Promise((done) => {
      const frames = [];
      const longTasks = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); });
      po.observe({ type: 'longtask', buffered: false });
      let last = performance.now();
      const end = last + seconds * 1000;
      function tick(t) {
        frames.push(t - last); last = t;
        window.scrollBy(0, 100);
        if (document.documentElement.scrollHeight - (window.scrollY + innerHeight) < 3000) append(10);
        if (t < end) requestAnimationFrame(tick);
        else { po.disconnect(); done({ frames: frames.slice(5), longTasks, cards: n }); }
      }
      requestAnimationFrame(tick);
    });
  `;
}

function linkedinPage(): string {
  // Cards are ~40 elements, like the real feed.
  const cardFn = `
    const feed = document.querySelector('[data-testid="mainFeed"]');
    function card() {
      const i = n++;
      const ad = i % 9 === 4;
      const body = Array.from({ length: 30 + (i % 20) }, (_, k) => words[(i * 7 + k) % words.length]).join(' ');
      const wrap = document.createElement('div');
      wrap.setAttribute('data-lazy-mount-id', 'm' + i);
      wrap.innerHTML =
        '<div role="listitem" componentkey="update-card-focus' + (10000 + i) + 'FeedType_MAIN_FEED_RELEVANCE">' +
          '<div class="_9c2e"><div class="_a1"><img class="_av" alt="" width="48" height="48">' +
            '<div><p componentkey="h' + i + 'a"><span>' + (ad ? 'Acme Widgets' : 'Person ' + i) + '</span></p>' +
            '<p componentkey="h' + i + 'b"><span>' + (ad ? 'Promoted' : 'Engineer · <time>' + (i % 59 + 1) + 'm</time>') + '</span></p></div>' +
            '<button class="_f" aria-label="Follow">Follow</button></div></div>' +
          '<div class="_77aa"><p componentkey="b' + i + '"><span>' + body + '</span></p>' +
            '<div class="_media" style="height:' + (200 + (i % 5) * 40) + 'px;background:#dde"></div></div>' +
          '<div class="_soc"><ul class="_r"><li><span class="_cnt">' + (i * 13 % 900) + '</span> reactions</li>' +
            '<li><span>' + (i % 40) + ' comments</span></li><li><span>' + (i % 9) + ' reposts</span></li></ul>' +
            '<div class="_act"><button>Like</button><button>Comment</button><button>Repost</button><button>Send</button></div></div>' +
        '</div>';
      return wrap;
    }
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><title>bench</title><style>
    body{font-family:system-ui;background:#f4f2ee;margin:0}._3a1f{max-width:560px;margin:0 auto;padding:16px}
    [role=listitem]{background:#fff;border-radius:8px;margin:8px 0;padding:12px}._r{display:flex;gap:8px;list-style:none;padding:0}
  </style></head><body><main><div class="_3a1f"><div data-testid="mainFeed" role="list"></div></div></main>
  <script>${benchScript(cardFn)}</script></body></html>`;
}

function facebookPage(): string {
  // Feed posts plus a right-hand rail whose sponsored module is what the
  // anchored block rule must find (and whose neighbours it must leave alone).
  const cardFn = `
    const feed = document.querySelector('[role="feed"]');
    function card() {
      const i = n++;
      const ad = i % 9 === 4;
      const body = Array.from({ length: 30 + (i % 20) }, (_, k) => words[(i * 7 + k) % words.length]).join(' ');
      const wrap = document.createElement('div');
      wrap.setAttribute('aria-posinset', String(i + 1));
      wrap.setAttribute('aria-describedby', 'd' + i);
      wrap.innerHTML =
        '<div class="_hdr"><img alt="" width="40" height="40"><div><h3><span><a href="/p' + i + '">' + (ad ? 'Acme Widgets' : 'Person ' + i) + '</a></span></h3>' +
          '<span>' + (ad ? '<a href="/ads/about" aria-label="Sponsored"><span>Sponsored</span></a>' : '<a href="/p' + i + '/posts/1">' + (i % 59 + 1) + 'm</a>') + '</span></div>' +
          '<div role="button" aria-label="Actions for this post">…</div></div>' +
        '<div class="_body" id="d' + i + '"><div dir="auto">' + body + '</div>' +
          '<div class="_media" style="height:' + (200 + (i % 5) * 40) + 'px;background:#dde"></div></div>' +
        '<div class="_soc"><span class="_cnt">' + (i * 13 % 900) + '</span><span>' + (i % 40) + ' comments</span>' +
          '<div class="_act"><div role="button">Like</div><div role="button">Comment</div><div role="button">Share</div></div></div>';
      return wrap;
    }
  `;
  const rail =
    '<div role="complementary"><div id="rail">' +
    '<div id="ads"><div><h3><span>Sponsored</span></h3></div>' +
    '<div><a aria-label="Advertiser" href="https://l.facebook.com/l.php?u=x"><img alt="" width="120" height="120"></a><div>Acme Widgets</div><div>acme.example</div></div>' +
    '<div><a aria-label="Advertiser" href="https://l.facebook.com/l.php?u=y"><img alt="" width="120" height="120"></a><div>Zed Tools</div><div>zed.example</div></div></div>' +
    '<div id="contacts"><h3>Contacts</h3>' +
    Array.from({ length: 12 }, (_, k) => `<a href="/friend${k}"><img alt="" width="36" height="36"><span>Friend ${k}</span></a>`).join('') +
    '</div></div></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>bench</title><style>
    body{font-family:system-ui;background:#f0f2f5;margin:0}main{display:flex;gap:16px;max-width:1100px;margin:0 auto;padding:16px}
    [role=feed]{flex:1;max-width:680px}[aria-posinset]{background:#fff;border-radius:8px;margin:8px 0;padding:12px}
    [role=complementary]{width:360px;position:sticky;top:16px;align-self:flex-start}#ads,#contacts{background:#fff;border-radius:8px;padding:12px;margin-bottom:12px}
    #contacts a{display:flex;gap:8px;padding:4px 0}
  </style></head><body><main><div role="feed"></div>${rail}</main>
  <script>${benchScript(cardFn)}</script></body></html>`;
}

const SITES: Record<string, Site> = {
  linkedin: { host: 'www.linkedin.com', url: 'https://www.linkedin.com/feed/', html: linkedinPage },
  facebook: { host: 'www.facebook.com', url: 'https://www.facebook.com/', html: facebookPage },
};
const site: Site = SITES[SITE] ?? ((): never => {
  console.error(`unknown --site ${SITE}; one of ${Object.keys(SITES).join(', ')}`);
  return process.exit(2);
})();

const ms = (a: Record<string, number>, b: Record<string, number>, k: string) => Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 1000);

type Raw = { frames: number[]; longTasks: number[]; cards: number };

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

async function run(withExt: boolean) {
  const context: BrowserContext = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [],
  });
  const html = site.html();
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname === site.host && route.request().resourceType() === 'document') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    return route.abort();
  });
  if (withExt && context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
  // The extension opens its options tab on install. If that lands mid-run the bench
  // tab goes to the background (1 Hz rAF), so wait for it and close it first.
  if (withExt && !context.pages().some((pg) => pg.url().startsWith('chrome-extension:'))) {
    await context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  }
  const p = await context.newPage();
  for (const other of context.pages()) if (other !== p) await other.close();
  await p.goto(site.url);
  await p.bringToFront();
  const cdp = await context.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }).metrics.map((m) => [m.name, m.value]));
  await p.waitForTimeout(1500); // a user reading the top of the page
  // Measure steady-state scrolling: let the first pass over the preloaded cards
  // finish (a real feed starts with ~10 cards; its first pass is reported apart).
  let before = withExt ? await pageState(context, 'sifter:getPageState') : null;
  const drainStart = Date.now();
  while (before && before.perf.pending > 0 && Date.now() - drainStart < 20_000) {
    await p.waitForTimeout(250);
    before = await pageState(context, 'sifter:getPageState');
  }
  const firstPassMs = before ? Date.now() - drainStart + 1500 : null;
  const atLoad = before;
  // Zero the peaks so the after-state's maxSliceMs is the scroll window's own.
  if (withExt) before = await pageState(context, 'sifter:resetPerfPeaks');
  const m0 = await metrics();
  const raw = (await p.evaluate((s) => (window as unknown as { __bench: (s: number) => Promise<Raw> }).__bench(s), SECONDS)) as Raw;
  const m1 = await metrics();
  await p.waitForTimeout(600); // drain the last debounce
  const after = withExt ? await pageState(context, 'sifter:getPageState') : null;
  const hidden = await p.evaluate(() => document.querySelectorAll('.sifter-hidden').length);
  const railIntact = await p.evaluate(() => {
    const ads = document.querySelector('#ads');
    if (!ads) return null; // linkedin page: no rail
    return ads.classList.contains('sifter-hidden') && !document.querySelector('#contacts')?.classList.contains('sifter-hidden') && !document.querySelector('#rail')?.classList.contains('sifter-hidden');
  });
  await context.close();

  const f = raw.frames;
  const dropped = f.reduce((acc, d) => acc + Math.max(0, Math.round(d / (1000 / 60)) - 1), 0);
  type Counter = { [K in keyof PageState['perf']]: PageState['perf'][K] extends number ? K : never }[keyof PageState['perf']];
  const d = (k: Counter) => (after && before ? after.perf[k] - before.perf[k] : null);
  return {
    ext: withExt,
    cards: raw.cards,
    hidden,
    /** facebook only: the sponsored rail module hidden and its neighbours not (null on linkedin). */
    railOk: withExt ? railIntact : null,
    frames: f.length,
    p50: +pct(f, 50).toFixed(1),
    p95: +pct(f, 95).toFixed(1),
    p99: +pct(f, 99).toFixed(1),
    worstFrame: +Math.max(...f).toFixed(1),
    dropped,
    // Main-thread time during the scroll, from Chrome itself (ms). Covers work the scanner's own counters cannot see.
    layoutMs: ms(m0, m1, 'LayoutDuration'),
    styleMs: ms(m0, m1, 'RecalcStyleDuration'),
    scriptMs: ms(m0, m1, 'ScriptDuration'),
    layouts: (m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0),
    styles: (m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0),
    longTasks: raw.longTasks.length,
    longTaskMs: +raw.longTasks.reduce((a, b) => a + b, 0).toFixed(0),
    // Scanner cost during the scroll only (the initial load is excluded).
    scanMs: after && before ? +(after.perf.totalMs - before.perf.totalMs).toFixed(1) : null,
    collectMs: after && before ? +(after.perf.collectMs - before.perf.collectMs).toFixed(1) : null,
    scans: d('scans'),
    fullScans: d('fullScans'),
    unitsExamined: d('unitsExamined'),
    unitsDecided: d('unitsDecided'),
    overBudget: d('slicesOverBudget'),
    slices: d('slices'),
    /** Longest slice during the scroll window (peaks were reset after the first pass). */
    maxSliceScroll: after ? +after.perf.maxSliceMs.toFixed(1) : null,
    maxCollectScroll: after ? +after.perf.maxCollectMs.toFixed(1) : null,
    maxDecideScroll: after ? +after.perf.maxDecideMs.toFixed(1) : null,
    worstSlice: after?.perf.worstSlice ? JSON.stringify(after.perf.worstSlice) : null,
    maxSliceAtLoad: atLoad ? +atLoad.perf.maxSliceMs.toFixed(1) : null,
    initialScanMs: atLoad ? +atLoad.perf.totalMs.toFixed(1) : null,
    firstPassWallMs: firstPassMs,
  };
}

async function pageState(context: BrowserContext, type: 'sifter:getPageState' | 'sifter:resetPerfPeaks'): Promise<PageState> {
  const sw = context.serviceWorkers()[0]!;
  return (await sw.evaluate(
    async ({ url, type }) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab!.id!, { type });
    },
    { url: `https://${site.host}/*`, type },
  )) as PageState;
}

type Result = Awaited<ReturnType<typeof run>>;

/** One line per on-run: what broke the budget, if anything. */
function verdict(off: Result, on: Result): string[] {
  const problems: string[] = [];
  if (CPU === 1 && (on.overBudget ?? 0) > 0) problems.push(`${on.overBudget} slice(s) over budget while scrolling`);
  if ((on.maxSliceScroll ?? 0) > LIMITS.maxSliceScrollMs) problems.push(`maxSliceScroll ${on.maxSliceScroll} ms > ${LIMITS.maxSliceScrollMs} ms`);
  if (on.longTasks > off.longTasks + LIMITS.extraLongTasks) problems.push(`longTasks ${on.longTasks} vs ${off.longTasks} off`);
  if (on.railOk === false) problems.push('rail module not hidden, or a neighbour was');
  if (on.hidden === 0) problems.push('nothing hidden: the bench is not exercising the scanner');
  return problems;
}

const results: Result[] = [];
for (let r = 0; r < RUNS; r++) {
  results.push(await run(false));
  results.push(await run(true));
}
console.table(results);
mkdirSync(join('bench', 'results'), { recursive: true });
const out = join('bench', 'results', `scroll-${SITE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ site: SITE, start: START, seconds: SECONDS, cpu: CPU, results }, null, 2));
console.log(`wrote ${out}`);

let failed = false;
for (let r = 0; r < RUNS; r++) {
  const problems = verdict(results[r * 2]!, results[r * 2 + 1]!);
  if (problems.length === 0) console.log(`run ${r + 1}: OK`);
  else {
    failed = true;
    console.log(`run ${r + 1}: ${problems.join('; ')}`);
  }
}
if (STRICT && failed) process.exit(1);
