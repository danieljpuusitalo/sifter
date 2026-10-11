import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import type { PageState } from '../src/messages';

// The live canary: does the build still find and hide ads on the real sites?
//
//   pnpm build && pnpm canary            every site, the built extension
//   pnpm canary --sites linkedin,google  some sites
//   pnpm canary --ext <unzipped dir>     a release build instead of .output/chrome-mv3
//
// Run it before writing a release, and whenever a site looks off. Sites change their
// markup without notice; this is how a selector drift shows up here before it shows up
// in a store review. It answers three questions per site:
//
//   FAIL  logged in, but the adapter matched no posts at all (selector drift), or a
//         sponsored label reached the screen uncovered (an ad Sifter missed).
//   WARN  logged out or blocked (Google's /sorry), so nothing was tested; or a miss on
//         an experimental site (Facebook, Threads), which ships as partial coverage.
//   INFO  ran fine but no ad was served this time, so hiding was not exercised.
//   PASS  ads were served and every one was covered.
//
// It cannot see a false hide (a real post hidden); only eyes catch that. Exit 1 on any FAIL.
//
// Local only: launches native Edge on the logged-in `.dev-profile-edge` (gitignored) as a
// plain process and attaches over CDP. A Playwright-launched browser gets Google's
// /sorry page, a plain one does not. Edge ignores --load-extension now, so the build is
// loaded through CDP (`Extensions.loadUnpacked`, as web-ext does). Refuses to start while
// that profile is open, and never closes a window it did not open. Read-only on the
// sites: it loads and scrolls, nothing else. Writes counts and URL paths only, never page
// text or links, to bench/results/ (gitignored).

/** Only inside `control.evaluate`, an extension page where the real `chrome` is in scope. */
declare const chrome: {
  runtime: { getManifest(): { name: string; version: string }; sendMessage(m: unknown): Promise<unknown> };
  tabs: {
    query(q: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? String(process.argv[i + 1]) : dflt;
};
const EXT = resolve(arg('ext', '.output/chrome-mv3'));
const PROFILE = resolve(arg('user-data', '.dev-profile-edge'));
const EDGE = arg('browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const PORT = Number(arg('port', '9334'));
const SECONDS = Number(arg('seconds', '20'));

type Site = { url: string; experimental?: boolean };
const FEEDS: Record<string, Site> = {
  linkedin: { url: 'https://www.linkedin.com/feed/' },
  reddit: { url: 'https://www.reddit.com/' },
  x: { url: 'https://x.com/home' },
  instagram: { url: 'https://www.instagram.com/' },
  facebook: { url: 'https://www.facebook.com/', experimental: true },
  threads: { url: 'https://www.threads.com/', experimental: true },
};
/** Commercial queries, so ads are likely. English UI, so the label words are known. */
const GOOGLE_QUERIES = ['running shoes', 'headphones', 'laptop'];
const ALL = [...Object.keys(FEEDS), 'google'];
const SITES = arg('sites', ALL.join(',')).split(',').filter(Boolean);
const unknown = SITES.filter((s) => !ALL.includes(s));
if (unknown.length) {
  console.error(`unknown site ${unknown.join(', ')}; one of ${ALL.join(', ')}`);
  process.exit(2);
}

type Verdict = 'PASS' | 'INFO' | 'WARN' | 'FAIL';
type Labels = { total: number; covered: number; onScreenUncovered: number; laterCovered: number; unmounted: number; neverOnScreen: number };
type Row = {
  site: string;
  verdict: Verdict;
  why: string;
  path: string;
  units?: number;
  sponsored?: number;
  hiddenNow?: number;
  labels?: Labels;
};

/** Everything a sponsored label reads as, on the sites Sifter covers, in English and Dutch. */
const LABEL = /^(Sponsored|Sponsored products?|Sponsored results?|Ad|Ads|Promoted|Gesponsord|Advertentie)$/;

async function startEdge(): Promise<ChildProcess> {
  if (!existsSync(join(EXT, 'manifest.json'))) throw new Error(`no extension at ${EXT}: run \`pnpm build\` first`);
  if (!existsSync(PROFILE)) throw new Error(`no profile at ${PROFILE}: see CLAUDE.md (dev profile)`);
  const child = spawn(
    EDGE,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      '--enable-unsafe-extension-debugging',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  // With the profile already open, Edge hands the arguments to that window and exits at
  // once, so no debug port appears. Say so rather than touching the user's window.
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) {
      throw new Error(`${PROFILE} is already open in Edge. Close that window and run again.`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`Edge did not open a debug port on ${PORT}`);
}

/**
 * Loads the build and opens its options page as the control page: an extension page
 * can query tabs and message content scripts, and unlike the service worker it does
 * not go idle or hide from CDP.
 */
async function loadSifter(context: BrowserContext, cdp: CDPSession): Promise<Page> {
  // Backslashes fail here with "File path cannot be resolved".
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT.replaceAll('\\', '/') });
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/options.html`);
  const name = await control.evaluate(() => chrome.runtime.getManifest().name);
  if (name !== 'Sifter') throw new Error(`${EXT} loaded as "${name}", not Sifter`);
  return control;
}

async function pageState(control: Page, page: Page): Promise<PageState | null> {
  try {
    return (await control.evaluate(
      async ({ url }) => {
        const [tab] = await chrome.tabs.query({ url });
        return chrome.tabs.sendMessage(tab!.id!, { type: 'sifter:getPageState' });
      },
      { url: `${new URL(page.url()).origin}/*` },
    )) as PageState;
  } catch {
    return null;
  }
}

/** Store defaults: sponsored only, collapse. The dev profile keeps whatever the last session set. */
async function useDefaults(control: Page): Promise<void> {
  await control.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'sifter:setCategory', category: 'sponsored', value: true });
    await chrome.runtime.sendMessage({ type: 'sifter:setCategory', category: 'suggested', value: false });
    await chrome.runtime.sendMessage({ type: 'sifter:setHideMode', mode: 'collapse' });
  });
}

/** Logged out, or a wall in front of the content: nothing here can be judged. */
async function blocked(page: Page): Promise<string | null> {
  const path = new URL(page.url()).pathname;
  if (path.startsWith('/sorry')) return "Google's unusual-traffic page";
  if (/login|authwall|signup|checkpoint|i\/flow/.test(path)) return 'logged out';
  const passwordShowing = await page
    .evaluate(() => [...document.querySelectorAll('input[type="password"]')].some((e) => e.checkVisibility()))
    .catch(() => false);
  return passwordShowing ? 'logged out' : null;
}

/**
 * One sweep of the label tracker. Every leaf reading exactly a sponsored label is
 * counted once; one first seen uncovered is watched until it is covered, unmounts,
 * or reaches the screen still uncovered, which is the miss. A label covered by any
 * Sifter class (hidden, collapsed, tagged, or Sifter's own bar) counts as covered.
 */
async function sweep(page: Page): Promise<void> {
  // No named functions inside: tsx wraps them in `__name()`, which does not exist in the
  // page, and the whole sweep throws (the first run counted 0 labels next to 7 hides).
  await page
    .evaluate((source) => {
      const re = new RegExp(source);
      const COVER = '[class*="sifter-"]';
      type Lab = { seen: WeakSet<Element>; pending: Element[]; total: number; covered: number; onScreenUncovered: number; laterCovered: number; unmounted: number };
      const w = window as unknown as { __canary?: Lab };
      const lab = (w.__canary ??= { seen: new WeakSet(), pending: [], total: 0, covered: 0, onScreenUncovered: 0, laterCovered: 0, unmounted: 0 });
      lab.pending = lab.pending.filter((e) => {
        if (!e.isConnected) return (lab.unmounted++, false);
        if (e.closest(COVER)) return (lab.laterCovered++, false);
        const r = e.getBoundingClientRect();
        if (r.bottom > 0 && r.top < innerHeight && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return (lab.onScreenUncovered++, false);
        }
        return true;
      });
      for (const e of document.querySelectorAll('span,div,a,p')) {
        if (e.childElementCount !== 0 || lab.seen.has(e)) continue;
        if (!re.test((e.textContent ?? '').trim())) continue;
        const covered = !!e.closest(COVER);
        if (!covered && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        lab.seen.add(e);
        lab.total++;
        if (covered) lab.covered++;
        else lab.pending.push(e);
      }
    }, LABEL.source)
    .catch(() => {});
}

async function labels(page: Page): Promise<Labels> {
  await sweep(page);
  const l = await page
    .evaluate(() => (window as unknown as { __canary?: Labels & { pending: unknown[] } }).__canary)
    .catch(() => undefined);
  if (!l) return { total: 0, covered: 0, onScreenUncovered: 0, laterCovered: 0, unmounted: 0, neverOnScreen: 0 };
  return {
    total: l.total,
    covered: l.covered,
    onScreenUncovered: l.onScreenUncovered,
    laterCovered: l.laterCovered,
    unmounted: l.unmounted,
    neverOnScreen: l.pending.length,
  };
}

async function scroll(page: Page, seconds: number): Promise<void> {
  await page.mouse.move(700, 500);
  for (let t = 0; t < seconds * 2; t++) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(500);
    await sweep(page);
  }
}

/** Load, and recover once from a tab that loaded before the content script was ready. */
async function load(page: Page, control: Page, url: string): Promise<PageState | null> {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(6000);
  let state = await pageState(control, page);
  if (!state && !(await blocked(page))) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    state = await pageState(control, page);
  }
  return state;
}

function judge(site: string, experimental: boolean, path: string, state: PageState | null, lab: Labels, isFeed: boolean): Row {
  const base = { site, path, units: state?.units, sponsored: state?.counts.sponsored ?? 0, hiddenNow: state?.hiddenNow, labels: lab };
  if (!state) return { ...base, verdict: 'FAIL', why: 'the content script did not answer: is the site still in the manifest matches?' };
  if (!state.enabled) return { ...base, verdict: 'WARN', why: 'Sifter is switched off for this site in the dev profile' };
  if (isFeed && (state.units === 0 || state.noUnitsMatched)) {
    return { ...base, verdict: 'FAIL', why: 'no posts matched: the site has likely changed its markup (adapter unitSelector)' };
  }
  if (lab.onScreenUncovered > 0) {
    const why = `${lab.onScreenUncovered} sponsored label(s) reached the screen uncovered`;
    return experimental ? { ...base, verdict: 'WARN', why: `${why} (experimental site)` } : { ...base, verdict: 'FAIL', why };
  }
  if ((state.counts.sponsored ?? 0) === 0 && lab.total === 0) return { ...base, verdict: 'INFO', why: 'no ad was served this run' };
  // Positive control: Sifter hid ads, so their labels were on the page. Seeing none means
  // the miss check above did not run, and a pass here would be vacuous.
  if (lab.total === 0) return { ...base, verdict: 'WARN', why: 'Sifter hid ads but the label check saw none, so misses went unchecked' };
  return { ...base, verdict: 'PASS', why: `${state.counts.sponsored ?? 0} sponsored hidden, none missed on screen` };
}

async function runFeed(context: BrowserContext, control: Page, site: string): Promise<Row> {
  const { url, experimental = false } = FEEDS[site]!;
  const page = await context.newPage();
  try {
    await load(page, control, url);
    const wall = await blocked(page);
    if (wall) return { site, verdict: 'WARN', why: `${wall}: log in to the dev profile and rerun`, path: new URL(page.url()).pathname };
    await scroll(page, SECONDS);
    await page.waitForTimeout(1500);
    const lab = await labels(page);
    return judge(site, experimental, new URL(page.url()).pathname, await pageState(control, page), lab, true);
  } finally {
    await page.close().catch(() => {});
  }
}

async function runGoogle(context: BrowserContext, control: Page): Promise<Row[]> {
  const rows: Row[] = [];
  const page = await context.newPage();
  try {
    for (const q of GOOGLE_QUERIES) {
      const state = await load(page, control, `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`);
      const site = `google "${q}"`;
      const wall = await blocked(page);
      if (wall) {
        rows.push({ site, verdict: 'WARN', why: `${wall}: skipped the remaining queries`, path: new URL(page.url()).pathname });
        break;
      }
      await scroll(page, 3);
      const lab = await labels(page);
      rows.push(judge(site, false, new URL(page.url()).pathname, (await pageState(control, page)) ?? state, lab, false));
      await page.waitForTimeout(3000);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return rows;
}

async function main() {
  const edge = await startEdge();
  let browser: Browser | undefined;
  const rows: Row[] = [];
  let version = '?';
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0]!;
    const control = await loadSifter(context, await browser.newBrowserCDPSession());
    version = await control.evaluate(() => chrome.runtime.getManifest().version);
    console.log(`canary: Sifter ${version} from ${EXT}`);
    await useDefaults(control);
    for (const site of SITES) {
      const got = site === 'google' ? await runGoogle(context, control) : [await runFeed(context, control, site)];
      for (const r of got) {
        rows.push(r);
        const nums = r.units === undefined ? '' : `  units ${r.units}, hidden ${r.sponsored}, labels ${r.labels?.total ?? 0}`;
        console.log(`${r.verdict.padEnd(4)}  ${r.site.padEnd(24)} ${r.why}${nums}`);
      }
    }
  } finally {
    // Close the browser this run started, and only that one.
    if (browser) {
      await browser
        .newBrowserCDPSession()
        .then((s) => s.send('Browser.close'))
        .catch(() => {});
      await browser.close().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (edge.exitCode === null) edge.kill();
  }

  const fails = rows.filter((r) => r.verdict === 'FAIL').length;
  const warns = rows.filter((r) => r.verdict === 'WARN').length;
  const dir = resolve('bench/results');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(dir, `canary-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), version, ext: EXT, fails, warns, rows }, null, 2)}\n`);
  console.log(`canary: ${fails} fail, ${warns} warn, ${rows.length - fails - warns} ok. Wrote ${file}`);
  process.exit(fails ? 1 : 0);
}

main().catch((e: Error) => {
  console.error(`canary: ${e.message}`);
  process.exit(2);
});
