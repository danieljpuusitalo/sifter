import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { STABILITY_PROBE, summariseStability, type StabRaw } from './stability';

// Live-site cost trace (hard rule 7, measured where it matters).
//
// The synthetic bench (`bench/scroll.ts`) times the scanner's own slices. It can't
// see what a real feed makes Sifter pay: MutationObserver callbacks on every
// React commit, style recalcs a computed-style read forces, GC. This script
// scrolls a real, logged-in feed in native Edge on the persistent dev profile,
// records a Chrome trace, and attributes every main-thread millisecond whose
// JavaScript entry point lives in `chrome-extension://` to Sifter, including
// the style and layout work nested inside those calls.
//
//   SIFTER_TRACE=1 pnpm build && pnpm bench:live --site linkedin|facebook|reddit|x|instagram [--seconds 20] [--load-seconds 5] [--mode on|off|both] [--suggested] [--profile]
//   pnpm bench:live analyse <trace.json>
//
// `--profile` adds the trace's v8.cpu_profiler samples (the CDP Profiler sees only the
// main world) and prints self time per function; build with SIFTER_NOMINIFY=1 first
// for readable names, and rebuild normally afterwards.
//
// Each run starts with a cold load: the trace begins before the navigation, so
// Sifter's main-thread ms over the first `--load-seconds` and the moment the first
// feed post appears compare on vs off. Built with SIFTER_TRACE=1, the scanner also
// reports hide latency (content to hide, split by where the post was) and flips
// (a hide let go by no choice of the user's), for the load and for the scroll.
// A plain `pnpm build` leaves those out; rebuild normally afterwards either way.
//
// Local only: needs the logged-in `.dev-profile-edge` (gitignored) and closes any
// window on it first. Writes a summary with counts and timings only, never page
// content, to bench/results/ (gitignored). The raw trace goes to the OS temp dir.

/** Only inside `sw.evaluate`, where the service worker's real `chrome` is in scope. */
declare const chrome: {
  tabs: {
    query(q: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? String(process.argv[i + 1]) : dflt;
};
const SITE = arg('site', 'linkedin');
const SECONDS = Number(arg('seconds', '20'));
const LOAD_SECONDS = Number(arg('load-seconds', '5'));
const MODE = arg('mode', 'both');
const SUGGESTED = process.argv.includes('--suggested');
const PROFILE_MODE = process.argv.includes('--profile');
const PROFILE = resolve(arg('user-data', '.dev-profile-edge'));
const EDGE = arg('browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const EXT = resolve(arg('ext', '.output/chrome-mv3'));
const TRACE_DIR = arg('trace-dir', join(process.env.TEMP ?? '.', 'sifter-traces'));

const URLS: Record<string, string> = {
  linkedin: 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
  reddit: 'https://www.reddit.com/',
  x: 'https://x.com/home',
  instagram: 'https://www.instagram.com/',
  threads: 'https://www.threads.net/',
  google: 'https://www.google.com/search?q=running+shoes',
};

const CATEGORIES = [
  'devtools.timeline',
  'v8.execute',
  'toplevel',
  'blink.user_timing',
  'disabled-by-default-devtools.timeline.frame',
  // Stack traces on forced style/layout, so a sync layout names the line that forced it.
  'disabled-by-default-devtools.timeline.stack',
  'v8',
].join(',');

type Ev = {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { url?: string; functionName?: string; frame?: string } } & Record<string, unknown>;
};

async function launch(withExt: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: false,
    viewport: null,
    args: [
      ...(withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : ['--disable-extensions']),
      '--disable-sync',
      // A tab that loses focus drops to 1 fps rAF and its trace is meaningless.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--no-first-run',
      '--window-size=1400,1000',
      '--window-position=0,0',
    ],
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  });
}

/**
 * Sets the suggested category to the flag's value on every on-run. The dev profile
 * keeps extension storage between runs, so a `--suggested` run used to leave the
 * category on for every later run without the flag: a "baseline" measured with 44
 * hidden posts instead of 9 (2026-09-28).
 */
async function setSuggested(context: BrowserContext, value: boolean): Promise<void> {
  if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker', { timeout: 10000 });
  const id = new URL(context.serviceWorkers()[0]!.url()).host;
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`);
  await opt.evaluate(async (v) => {
    const rt = (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime;
    await rt.sendMessage({ type: 'sifter:setCategory', category: 'suggested', value: v });
  }, value);
  await opt.close();
}

async function recordTrace(cdp: CDPSession, file: string, run: () => Promise<void>): Promise<void> {
  const categories = PROFILE_MODE ? `${CATEGORIES},disabled-by-default-v8.cpu_profiler` : CATEGORIES;
  await cdp.send('Tracing.start', { categories, transferMode: 'ReturnAsStream' });
  await run();
  const done = new Promise<string>((res) => cdp.once('Tracing.tracingComplete', (e) => res(e.stream as string)));
  await cdp.send('Tracing.end');
  const handle = await done;
  const out = createWriteStream(file);
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle, size: 1 << 20 });
    out.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle });
  await new Promise<void>((r) => out.end(r));
}

/** A person flicking through a feed: wheel ticks in bursts, short pauses to read. */
async function humanScroll(page: Page, seconds: number): Promise<void> {
  await page.mouse.move(700, 500);
  const end = Date.now() + seconds * 1000;
  let burst = 0;
  while (Date.now() < end) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(40);
    if (++burst % 12 === 0) await page.waitForTimeout(400);
  }
}

type ProfNode = { id: number; parent?: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type Profile = { nodes: ProfNode[]; samples: number[]; timeDeltas: number[] };

/** The isolate-wide sampled profile a trace carries (ProfileChunk events), merged per profile id; the busiest one wins. */
function traceProfile(events: Ev[]): Profile | null {
  const byId = new Map<string, Profile>();
  for (const e of events) {
    if (e.name !== 'ProfileChunk') continue;
    const data = (e.args as { data?: { cpuProfile?: { nodes?: ProfNode[]; samples?: number[] }; timeDeltas?: number[] } }).data;
    const id = String((e as unknown as { id: string }).id);
    const p = byId.get(id) ?? { nodes: [], samples: [], timeDeltas: [] };
    p.nodes.push(...(data?.cpuProfile?.nodes ?? []));
    p.samples.push(...(data?.cpuProfile?.samples ?? []));
    p.timeDeltas.push(...(data?.timeDeltas ?? []));
    byId.set(id, p);
  }
  return [...byId.values()].sort((a, b) => b.samples.length - a.samples.length)[0] ?? null;
}

/**
 * Where the extension's JS time goes, from a sampled V8 CPU profile: self time by
 * leaf frame (DOM calls show as the native leaf under our function), and
 * inclusive time by our own functions. Only stacks with a chrome-extension frame count.
 */
function profileSummary(p: Profile) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) {
    for (const c of n.children ?? []) parent.set(c, n.id);
    if (n.parent !== undefined) parent.set(n.id, n.parent);
  }
  const label = (n: ProfNode) =>
    `${n.callFrame.functionName || '(anon)'}${n.callFrame.url ? `@${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}` : ''}`;
  const self = new Map<string, number>();
  const incl = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000;
    const stack: ProfNode[] = [];
    for (let id: number | undefined = p.samples[i]; id !== undefined; id = parent.get(id)) stack.push(byId.get(id)!);
    const ours = stack.filter((n) => (n.callFrame.url ?? '').startsWith('chrome-extension://'));
    if (!ours.length) continue;
    total += dt;
    // Leaf plus its nearest caller of ours, so a shared helper (normaliseText) says who pays for it.
    const caller = ours.find((n) => n !== stack[0]);
    const key = `${label(stack[0]!)}${caller ? `  <- ${label(caller)}` : ''}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    for (const l of new Set(ours.map(label))) incl.set(l, (incl.get(l) ?? 0) + dt);
  }
  const top = (m: Map<string, number>, k: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([f, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${f}`);
  const schemes = new Map<string, number>();
  for (const n of p.nodes) {
    const s = (n.callFrame.url ?? '').split('/').slice(0, 3).join('/') || '(none)';
    schemes.set(s, (schemes.get(s) ?? 0) + 1);
  }
  return { totalMs: +total.toFixed(1), samples: p.samples.length, urls: [...schemes.entries()].slice(0, 12), self: top(self, 25), inclusive: top(incl, 25) };
}

/** The adapter's own unit selector, so "first post" means what the scanner means by a post. */
function unitSelector(): string | null {
  try {
    return (JSON.parse(readFileSync(join('src/adapters', `${SITE}.json`), 'utf8')) as { unitSelector?: string }).unitSelector ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs before the page's own scripts: the first frame after a feed post with text
 * exists (about its first paint), and the largest contentful paint. One query per
 * frame until the post shows up, in the main world, so on- and off-runs pay it alike.
 */
const FEED_PROBE = (selector: string | null) => `
  window.__feed = { firstPost: null, lcp: null };
  try {
    new PerformanceObserver((l) => { const e = l.getEntries(); window.__feed.lcp = e[e.length - 1].startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  const sel = ${JSON.stringify(selector)};
  const look = () => {
    if (!sel || window.__feed.firstPost !== null) return;
    let found = false;
    try { for (const el of document.querySelectorAll(sel)) if ((el.textContent || '').trim()) { found = true; break; } } catch {}
    if (found) requestAnimationFrame((t) => { window.__feed.firstPost = t; });
    else requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
`;

const FRAME_PROBE = `
  window.__frames = [];
  (function tick(prev) { requestAnimationFrame((t) => { if (prev) window.__frames.push(t - prev); tick(t); }); })(0);
`;

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(1);
}

/** Main-thread attribution from a trace file. */
export function analyse(file: string) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { traceEvents?: Ev[] } | Ev[];
  const events = Array.isArray(raw) ? raw : (raw.traceEvents ?? []);
  // The page's renderer main thread: CrRendererMain with the most JS entries naming the site.
  const names = new Map<string, string>();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, String(e.args?.name));
  const score = new Map<string, number>();
  for (const e of events) {
    const k = `${e.pid}:${e.tid}`;
    if (names.get(k) !== 'CrRendererMain') continue;
    if (e.ph === 'X' && e.dur) score.set(k, (score.get(k) ?? 0) + e.dur);
  }
  const main = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mt = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X' && typeof e.dur === 'number');
  mt.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));

  const isExt = (e: Ev) => (e.args?.data?.url ?? '').startsWith('chrome-extension://');
  const tasks = mt.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  // Outermost extension JS entries: an entry nested inside another extension entry is not counted twice.
  const stack: Ev[] = [];
  let extMs = 0;
  let extCalls = 0;
  const byFn = new Map<string, { ms: number; n: number; max: number }>();
  const extSpans: { ts: number; end: number }[] = [];
  const nestedStyle = { ms: 0, n: 0, max: 0 };
  const nestedLayout = { ms: 0, n: 0, max: 0 };
  let openExt: Ev | null = null;
  const forcers = new Map<string, { ms: number; n: number }>();
  for (const e of mt) {
    while (stack.length && stack[stack.length - 1]!.ts + (stack[stack.length - 1]!.dur ?? 0) <= e.ts) {
      const top = stack.pop()!;
      if (top === openExt) openExt = null;
    }
    if (openExt && e.ts < openExt.ts + (openExt.dur ?? 0)) {
      if (['UpdateLayoutTree', 'RecalculateStyles', 'Layout'].includes(e.name)) {
        const st = (e.args as { beginData?: { stackTrace?: { functionName: string; lineNumber: number; columnNumber: number; url: string }[] } })
          .beginData?.stackTrace;
        if (st?.length) {
          const key = `${e.name} <- ${st
            .slice(0, 4)
            .map((f) => `${f.functionName || '(anon)'}@${f.url.split('/').pop()}:${f.lineNumber}`)
            .join(' <- ')}`;
          const f = forcers.get(key) ?? { ms: 0, n: 0 };
          f.ms += e.dur! / 1000;
          f.n++;
          forcers.set(key, f);
        }
      }
      if (e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles') {
        nestedStyle.ms += e.dur! / 1000;
        nestedStyle.n++;
        nestedStyle.max = Math.max(nestedStyle.max, e.dur! / 1000);
      } else if (e.name === 'Layout') {
        nestedLayout.ms += e.dur! / 1000;
        nestedLayout.n++;
        nestedLayout.max = Math.max(nestedLayout.max, e.dur! / 1000);
      }
    } else if (isExt(e)) {
      openExt = e;
      const ms = e.dur! / 1000;
      extMs += ms;
      extCalls++;
      extSpans.push({ ts: e.ts, end: e.ts + e.dur! });
      const key = `${e.name}:${e.args?.data?.functionName || '(anon)'}`;
      const f = byFn.get(key) ?? { ms: 0, n: 0, max: 0 };
      f.ms += ms;
      f.n++;
      f.max = Math.max(f.max, ms);
      byFn.set(key, f);
    }
    stack.push(e);
  }
  // Extension time per top-level task: the number a user can feel in one frame.
  const perTask: number[] = [];
  let si = 0;
  for (const t of tasks) {
    const end = t.ts + t.dur!;
    let sum = 0;
    while (si < extSpans.length && extSpans[si]!.end <= t.ts) si++;
    for (let j = si; j < extSpans.length && extSpans[j]!.ts < end; j++) sum += extSpans[j]!.end - extSpans[j]!.ts;
    if (sum > 0) perTask.push(sum / 1000);
  }
  const first = mt[0]?.ts ?? 0;
  const last = mt.length ? mt[mt.length - 1]!.ts : 0;
  const seconds = (last - first) / 1e6 || 1;
  const sumName = (n: string[]) => mt.filter((e) => n.includes(e.name)).reduce((a, e) => a + e.dur! / 1000, 0);
  const longTasks = tasks.filter((t) => t.dur! > 50000).length;
  const busyMs = tasks.reduce((a, t) => a + t.dur! / 1000, 0);
  return {
    traceSeconds: +seconds.toFixed(1),
    mainThreadBusyMsPerSec: +(busyMs / seconds).toFixed(1),
    longTasks,
    ext: {
      msPerSec: +(extMs / seconds).toFixed(2),
      totalMs: +extMs.toFixed(1),
      calls: extCalls,
      tasksTouched: perTask.length,
      perTaskP50: pct(perTask, 50),
      perTaskP95: pct(perTask, 95),
      perTaskP99: pct(perTask, 99),
      perTaskMax: pct(perTask, 100),
      tasksOver2ms: perTask.filter((x) => x > 2).length,
      tasksOver4ms: perTask.filter((x) => x > 4).length,
      forcedStyle: { ms: +nestedStyle.ms.toFixed(1), n: nestedStyle.n, max: +nestedStyle.max.toFixed(2) },
      forcedLayout: { ms: +nestedLayout.ms.toFixed(1), n: nestedLayout.n, max: +nestedLayout.max.toFixed(2) },
      forcedBy: [...forcers.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 8)
        .map(([k, v]) => ({ at: k, ms: +v.ms.toFixed(1), n: v.n })),
      byEntry: [...byFn.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 12)
        .map(([k, v]) => ({ entry: k, ms: +v.ms.toFixed(1), n: v.n, max: +v.max.toFixed(2) })),
    },
    page: {
      styleMs: +sumName(['UpdateLayoutTree', 'RecalculateStyles']).toFixed(1),
      layoutMs: +sumName(['Layout']).toFixed(1),
      gcMs: +sumName(['MinorGC', 'MajorGC', 'V8.GC_SCAVENGER', 'BlinkGC.AtomicPhase']).toFixed(1),
    },
  };
}

/** The scanner's own counters, over the feed tab, via the service worker (page context can't message it). */
type Perf = Record<string, number | null | Record<string, number>>;
/** content/trace.ts's TraceStats; only in a SIFTER_TRACE=1 build. Counts and rule ids, never page text. */
type Trace = { arrival?: Record<string, unknown>; latency: Record<string, unknown>; flips: unknown[]; flipCount: number; hiddenLeft: number };
type ScannerState = { perf: Perf; trace: Trace | null };

/**
 * The share of hides over the scroll that the reader could read first: hidden while on
 * screen, readable until the decision. Needs the trace (the hide latency buckets count
 * the debounced pass's hides by where they landed). A tag is blurred, so one scrolled
 * onto the screen (`tagsScrolledIn`, reported alongside) is not readable.
 */
function exposure(laneHits: number | null, tagsScrolledIn: number | null, trace: Trace | null) {
  const lat = trace?.latency as Record<string, { n: number }> | undefined;
  if (laneHits === null || tagsScrolledIn === null || !lat?.alreadyOnScreen) return null;
  const hidOn = lat.alreadyOnScreen.n + (lat.enteredWhileQueued?.n ?? 0);
  const hides = laneHits + hidOn + (lat.offScreen?.n ?? 0);
  return { hides, readable: hidOn, hidOnScreen: hidOn, tagsScrolledIn, pct: hides ? Math.round((1000 * hidOn) / hides) / 10 : null };
}
async function scannerState(context: BrowserContext, type: 'sifter:getPageState' | 'sifter:resetPerfPeaks'): Promise<ScannerState | null> {
  const sw = context.serviceWorkers()[0];
  if (!sw) return null;
  try {
    const state = (await sw.evaluate(
      async ({ url, type }) => {
        const [tab] = await chrome.tabs.query({ url });
        return chrome.tabs.sendMessage(tab!.id!, { type });
      },
      { url: `${new URL(URLS[SITE] ?? SITE).origin}/*`, type },
    )) as { perf?: Perf; trace?: Trace } | null;
    return state?.perf ? { perf: state.perf, trace: state.trace ?? null } : null;
  } catch {
    return null;
  }
}

async function runOnce(withExt: boolean) {
  const context = await launch(withExt);
  try {
    if (withExt) await setSuggested(context, SUGGESTED);
    const page = await context.newPage();
    // First install opens the options page; any other tab would take focus from the feed.
    await page.waitForTimeout(1500);
    for (const p of context.pages()) if (p !== page) await p.close();
    await page.bringToFront();
    await page.addInitScript(FEED_PROBE(unitSelector()));
    const cdp = await context.newCDPSession(page);
    mkdirSync(TRACE_DIR, { recursive: true });
    const stamp = `${SITE}-${withExt ? 'on' : 'off'}-${Date.now()}`;
    // Cold load: the trace starts before the navigation, so Sifter's start-up scan is in it.
    const loadFile = join(TRACE_DIR, `${stamp}-load.json`);
    await recordTrace(cdp, loadFile, async () => {
      await page.goto(URLS[SITE] ?? SITE, { waitUntil: 'commit' });
      await page.waitForTimeout(LOAD_SECONDS * 1000);
    });
    const loadTrace = analyse(loadFile);
    const feed = await page.evaluate(() => {
      const f = (window as unknown as { __feed?: { firstPost: number | null; lcp: number | null } }).__feed;
      const fcp = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime ?? null;
      return { firstPost: f?.firstPost ?? null, lcp: f?.lcp ?? null, fcp };
    });
    const ms = (x: number | null) => (x === null ? null : Math.round(x));
    for (const p of context.pages()) if (p !== page) await p.close();
    await page.bringToFront();
    await page.waitForTimeout(3000);
    await page.evaluate(FRAME_PROBE);
    await page.evaluate(STABILITY_PROBE);
    const t0 = await page.evaluate(() => performance.now());
    const file = join(TRACE_DIR, `${stamp}.json`);
    // The load's latency and flips, read before the reset starts the scroll window.
    const atLoad = withExt ? await scannerState(context, 'sifter:getPageState') : null;
    if (withExt && !atLoad?.trace) console.warn('[live] no hide trace: build with SIFTER_TRACE=1 for latency and flips');
    const load = {
      seconds: LOAD_SECONDS,
      firstPostMs: ms(feed.firstPost),
      fcpMs: ms(feed.fcp),
      lcpMs: ms(feed.lcp),
      mainThreadBusyMsPerSec: loadTrace.mainThreadBusyMsPerSec,
      longTasks: loadTrace.longTasks,
      ext: { totalMs: loadTrace.ext.totalMs, calls: loadTrace.ext.calls, perTaskMax: loadTrace.ext.perTaskMax, tasksOver4ms: loadTrace.ext.tasksOver4ms },
      hidesAtLoad: atLoad ? (atLoad.perf.hidesAtLoad ?? null) : null,
      trace: atLoad?.trace ?? null,
    };
    // Counters over the scroll only: peaks (and the trace) reset after the load-time scan.
    const before = withExt ? ((await scannerState(context, 'sifter:resetPerfPeaks'))?.perf ?? null) : null;
    await recordTrace(cdp, file, () => humanScroll(page, SECONDS));
    const afterState = withExt ? await scannerState(context, 'sifter:getPageState') : null;
    const after = afterState?.perf ?? null;
    const n = (k: string) => (before && after && typeof after[k] === 'number' && typeof before[k] === 'number' ? (after[k] as number) - (before[k] as number) : null);
    const scanner = after
      ? {
          unitsExamined: n('unitsExamined'),
          unitsDecided: n('unitsDecided'),
          slices: n('slices'),
          scanMs: n('totalMs') === null ? null : +(n('totalMs') as number).toFixed(1),
          maxSliceMs: +(after.maxSliceMs as number).toFixed(1),
          maxDecideMs: +(after.maxDecideMs as number).toFixed(1),
          laneMaxMs: typeof after.laneMaxMs === 'number' ? +after.laneMaxMs.toFixed(2) : null,
          worstSlice: after.worstSlice ?? null,
          late: Object.fromEntries(['hidesAtLoad', 'lateInView', 'lateFarBelow', 'tagsCollapsed', 'railCollapsed', 'belowCameNear', 'collapsedMidScroll', 'tagsScrolledIn', 'laneUnits', 'laneHits', 'laneAbstain', 'laneOverBudget', 'laneFrameHits', 'laneFrameOverBudget', 'approachScans', 'approachPromotes', 'laneReleases', 'laneMs'].map((k) => [k, n(k)])),
          exposure: exposure(n('laneHits'), n('tagsScrolledIn'), afterState?.trace ?? null),
          trace: afterState?.trace ?? null,
        }
      : null;
    if (PROFILE_MODE) {
      // Sampling costs time itself: a profile run names hot functions, a plain run times them.
      // The CDP Profiler domain only sees the main world; the trace's sampler sees the isolate.
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { traceEvents?: Ev[] } | Ev[];
      const prof = traceProfile(Array.isArray(raw) ? raw : (raw.traceEvents ?? []));
      return { mode: withExt ? 'on' : 'off', load, profile: prof ? profileSummary(prof) : null, traceFile: file };
    }
    const frames = (await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)).slice(10);
    if (frames.length < SECONDS * 20) console.warn(`[live] only ${frames.length} frames: the tab was throttled, discard this run`);
    const visible = await page.evaluate(() => document.visibilityState);
    const hidden = await page.evaluate(() => document.querySelectorAll('.sifter-hidden').length);
    const stability = summariseStability(await page.evaluate(() => (window as unknown as { __stab?: StabRaw }).__stab ?? null), t0);
    return {
      mode: withExt ? 'on' : 'off',
      visible,
      hidden,
      load,
      stability,
      scanner,
      frames: {
        n: frames.length,
        p50: pct(frames, 50),
        p95: pct(frames, 95),
        p99: pct(frames, 99),
        over25: frames.filter((f) => f > 25).length,
        over50: frames.filter((f) => f > 50).length,
      },
      trace: analyse(file),
      traceFile: file,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  if (process.argv[2] === 'analyse') {
    console.log(JSON.stringify(analyse(process.argv[3]!), null, 2));
    return;
  }
  const modes = MODE === 'both' ? [false, true] : [MODE === 'on'];
  const results = [];
  for (const m of modes) {
    const r = await runOnce(m);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(
    join('bench/results', `live-${SITE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ site: SITE, seconds: SECONDS, suggested: SUGGESTED, results }, null, 2),
  );
}

void main();


