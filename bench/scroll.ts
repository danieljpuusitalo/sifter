import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from '@playwright/test';
import type { PageState } from '../src/messages';

// Scroll benchmark (hard rule 7: the extension must not cost frames).
//
// Serves a synthetic LinkedIn-shaped feed at https://www.linkedin.com/ (all other
// network aborted, like the e2e tests), then scrolls it the way a person does on
// a long session: the feed already holds `--start` cards, more are appended as
// the bottom nears, and the site keeps rewriting small text ("3m", reaction
// counts) in cards all the time. Runs the same scroll with the extension off and
// on, and reports frame intervals, long tasks and the scanner's own counters.
//
//   pnpm bench:scroll [--start 150] [--seconds 15] [--runs 2] [--cpu 4]
//
// Needs a build (.output/chrome-mv3); the script runs `wxt build` via the package
// script. Headless frame timings are noisy: compare off vs on in the same run,
// and trust the scanner's self-time (perf.totalMs, maxSliceMs) over small fps gaps.

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
const START = arg('start', 150);
const SECONDS = arg('seconds', 15);
const RUNS = arg('runs', 2);
/** CPU slowdown (DevTools throttling). This laptop is fast; most users' machines are not. */
const CPU = arg('cpu', 4);
const EXT = resolve('.output/chrome-mv3');

function page(): string {
  // Everything below runs in the page. Cards are ~40 elements, like the real feed.
  const script = `
    const feed = document.querySelector('[data-testid="mainFeed"]');
    let n = 0;
    const words = 'the team shipped a new release today with careful testing and thanks to everyone who helped along the way'.split(' ');
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>bench</title><style>
    body{font-family:system-ui;background:#f4f2ee;margin:0}._3a1f{max-width:560px;margin:0 auto;padding:16px}
    [role=listitem]{background:#fff;border-radius:8px;margin:8px 0;padding:12px}._r{display:flex;gap:8px;list-style:none;padding:0}
  </style></head><body><main><div class="_3a1f"><div data-testid="mainFeed" role="list"></div></div></main>
  <script>${script}</script></body></html>`;
}

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
  const html = page();
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname === 'www.linkedin.com' && route.request().resourceType() === 'document') {
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
  await p.goto('https://www.linkedin.com/feed/');
  await p.bringToFront();
  const cdp = await context.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }).metrics.map((m) => [m.name, m.value]));
  await p.waitForTimeout(1500); // a user reading the top of the page
  // Measure steady-state scrolling: let the first pass over the preloaded cards
  // finish (a real feed starts with ~10 cards; its first pass is reported apart).
  let before = withExt ? await pageState(context) : null;
  const drainStart = Date.now();
  while (before && before.perf.pending > 0 && Date.now() - drainStart < 20_000) {
    await p.waitForTimeout(250);
    before = await pageState(context);
  }
  const firstPassMs = before ? Date.now() - drainStart + 1500 : null;
  const m0 = await metrics();
  const raw = (await p.evaluate((s) => (window as unknown as { __bench: (s: number) => Promise<Raw> }).__bench(s), SECONDS)) as Raw;
  const m1 = await metrics();
  await p.waitForTimeout(600); // drain the last debounce
  const after = withExt ? await pageState(context) : null;
  const hidden = await p.evaluate(() => document.querySelectorAll('.sifter-hidden').length);
  await context.close();

  const f = raw.frames;
  const dropped = f.reduce((acc, d) => acc + Math.max(0, Math.round(d / (1000 / 60)) - 1), 0);
  return {
    ext: withExt,
    cards: raw.cards,
    hidden,
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
    scans: after && before ? after.perf.scans - before.perf.scans : null,
    fullScans: after && before ? after.perf.fullScans - before.perf.fullScans : null,
    unitsExamined: after && before ? after.perf.unitsExamined - before.perf.unitsExamined : null,
    unitsDecided: after && before ? after.perf.unitsDecided - before.perf.unitsDecided : null,
    overBudget: after && before ? after.perf.slicesOverBudget - before.perf.slicesOverBudget : null,
    slices: after && before ? after.perf.slices - before.perf.slices : null,
    maxSliceMs: after ? +after.perf.maxSliceMs.toFixed(1) : null,
    maxSliceAtLoad: before ? +before.perf.maxSliceMs.toFixed(1) : null,
    initialScanMs: before ? +before.perf.totalMs.toFixed(1) : null,
    firstPassWallMs: firstPassMs,
  };
}

async function pageState(context: BrowserContext): Promise<PageState> {
  const sw = context.serviceWorkers()[0]!;
  return (await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    return chrome.tabs.sendMessage(tab!.id!, { type: 'sifter:getPageState' });
  })) as PageState;
}

const results = [];
for (let r = 0; r < RUNS; r++) {
  results.push(await run(false));
  results.push(await run(true));
}
console.table(results);
mkdirSync(join('bench', 'results'), { recursive: true });
const out = join('bench', 'results', `scroll-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ start: START, seconds: SECONDS, cpu: CPU, results }, null, 2));
console.log(`wrote ${out}`);
