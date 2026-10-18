import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { adapterFor } from '../src/adapters';
import { Scanner } from '../src/content/scanner';
import { nearTracker } from '../src/content/near';
import { hideTrace } from '../src/content/trace';
import { viewportTracker } from '../src/content/viewport';
import { defaultContext, type BgRequest, type SiteContext, type TabRequest } from '../src/messages';
import { learnSelf, learnsOn } from '../src/self';
import { LAUNCH_MATCHES } from '../src/sites';

/** Backoff between retries of a service-worker message that may still be waking up. */
const CONTEXT_RETRY_DELAYS_MS = [300, 900];

/**
 * Send a message and retry on rejection (the service worker asleep or mid-update
 * both reject the promise, rather than answering late). Rejects with the last
 * error once the delays are exhausted, so callers decide the fallback.
 */
async function withRetry<T>(send: () => Promise<T>, delaysMs: number[]): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      lastErr = e;
      if (attempt >= delaysMs.length) throw lastErr;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/**
 * Probe for an instance already on this page. A live one answers; one orphaned by
 * an extension update (its runtime is gone, so it can't hear the popup or read
 * settings) stands down instead, so the new instance can take over its hides.
 */
const PROBE_EVENT = 'sifter:probe';
type Probe = { alive: boolean };

/** When to look for the viewer's own profile links, and the waits between later tries (the rail can render after the feed). */
const SELF_FIRST_TRY_MS = 1500;
const SELF_RETRY_DELAYS_MS = [3000, 10_000];

/** How long a refresh waits for the re-decide to finish before answering the popup. */
const SETTLE_CAP_MS = 1000;

/** At document_start there is no <body> yet, and the scanner scans and observes from it. */
function bodyReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const mo = new MutationObserver(() => {
      if (!document.body) return;
      mo.disconnect();
      resolve();
    });
    mo.observe(document.documentElement, { childList: true });
  });
}

export default defineContentScript({
  matches: LAUNCH_MATCHES,
  // Not document_idle: that waits for DOMContentLoaded, and on Facebook the Stories
  // bar was on screen 2.3-2.9 s before it (live, 2026-10-01). Starting here also
  // overlaps the settings round-trip with the page's own load.
  runAt: 'document_start',
  async main() {
    // The popup can inject this script into a tab that already has it.
    const probe: Probe = { alive: false };
    document.dispatchEvent(new CustomEvent<Probe>(PROBE_EVENT, { detail: probe }));
    if (probe.alive) return;

    // Claim the page before the first await. Install-time injection and the
    // content_scripts entry can both start within the same tick; a listener
    // registered only after the settings round-trip lets both instances run and
    // every hidden unit gets two placeholders.
    let scanner: Scanner | null = null;
    const onProbe = (e: Event) => {
      const detail = (e as CustomEvent<Probe | null>).detail;
      if (!detail) return; // not from one of our own instances
      if (browser.runtime?.id) {
        detail.alive = true;
        return;
      }
      document.removeEventListener(PROBE_EVENT, onProbe);
      scanner?.stop();
    };
    document.addEventListener(PROBE_EVENT, onProbe);

    const hostname = location.hostname;
    const send = <T>(msg: BgRequest) => browser.runtime.sendMessage(msg) as Promise<T>;
    const [context] = await Promise.all([
      withRetry(() => send<SiteContext>({ type: 'sifter:getContext', hostname }), CONTEXT_RETRY_DELAYS_MS).catch((e: unknown) => {
        console.warn('[sifter] could not load settings', e);
        return defaultContext(hostname);
      }),
      bodyReady(),
    ]);

    const live = new Scanner({
      doc: document,
      hostname,
      baseUrl: location.href,
      path: () => location.pathname,
      search: () => location.search,
      adapter: adapterFor(hostname),
      context,
      persistOverride: (fp, action) =>
        void send({ type: 'sifter:setOverride', hostname, fp, action }).catch(() => undefined),
      dev: import.meta.env.DEV,
      viewport: viewportTracker(window),
      near: nearTracker(window),
      trace: import.meta.env.DEV || import.meta.env.SIFTER_TRACE ? hideTrace(window) : undefined,
    });
    scanner = live;
    live.start();

    // Learn the viewer's profile id (adapter `self`) once the page chrome is in, off
    // the scroll path: one query of the rail, a few tries, then stop. A new id (another
    // account) replaces the stored one; the settings broadcast then re-decides the page.
    // Only while suggested is on here: it is the one thing the id is for. If it is turned
    // on later, the broadcast starts the same few tries (no polling).
    const adapter = adapterFor(hostname);
    const self = adapter?.self;
    let current = context;
    const learnWanted = (ctx: SiteContext) => ctx.enabled && ctx.categories.suggested;
    let learning = false;
    const startLearning = () => {
      if (!adapter || !self || learning || !learnWanted(current)) return;
      learning = true;
      const tryLearn = (delays: number[]) => {
        if (!learnWanted(current)) {
          learning = false;
          return;
        }
        const id = learnsOn(adapter, location.pathname) ? learnSelf(document, self) : null;
        if (id) {
          learning = false;
          if (id !== current.self) void send({ type: 'sifter:setSelf', hostname, id }).catch(() => undefined);
          return;
        }
        const [next, ...rest] = delays;
        if (next !== undefined) setTimeout(() => tryLearn(rest), next);
        else learning = false;
      };
      setTimeout(() => tryLearn(SELF_RETRY_DELAYS_MS), SELF_FIRST_TRY_MS);
    };
    startLearning();

    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    // A context plus whether it is paused right now: the same pausedUntil means
    // something else once that moment has passed.
    const keyOf = (ctx: SiteContext) => `${ctx.pausedUntil !== null && ctx.pausedUntil > Date.now()}${JSON.stringify(ctx)}`;
    let applied = keyOf(context);
    const refresh = async () => {
      const ctx = await withRetry(() => send<SiteContext>({ type: 'sifter:getContext', hostname }), CONTEXT_RETRY_DELAYS_MS);
      // The popup refreshes its tab at once and the settings broadcast follows it: the
      // second brings nothing new and must not re-decide the whole page again.
      const key = keyOf(ctx);
      if (key !== applied) {
        applied = key;
        current = ctx;
        live.applyContext(ctx);
        startLearning();
      }
      // Answer with the re-decided page, not a half-done one; but never hang the popup.
      await Promise.race([live.settled(), new Promise((r) => setTimeout(r, SETTLE_CAP_MS))]);
      clearTimeout(resumeTimer);
      if (ctx.pausedUntil !== null && ctx.pausedUntil > Date.now()) {
        resumeTimer = setTimeout(() => void refresh().catch(() => undefined), ctx.pausedUntil - Date.now() + 50);
      }
    };
    if (context.pausedUntil !== null && context.pausedUntil > Date.now()) void refresh().catch(() => undefined);

    // bfcache restores the page (and this script) without a fresh document_start
    // run, so settings could have drifted while it was frozen. Re-sync on the way
    // back in.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) void refresh().catch(() => undefined);
    });

    // The context menu's click reaches the service worker, not the page, so remember
    // what was right-clicked. Captured on window, not document, and ignores anything
    // the page itself dispatched. The record expires quickly: a real right-click and
    // the menu item click that follows it are milliseconds apart, not minutes.
    const RIGHT_CLICK_TTL_MS = 1500;
    let lastRightClicked: Element | null = null;
    let lastRightClickedAt = 0;
    window.addEventListener(
      'contextmenu',
      (e) => {
        if (!e.isTrusted) return;
        lastRightClicked = e.target instanceof Element ? e.target : null;
        lastRightClickedAt = Date.now();
      },
      { capture: true, passive: true },
    );
    const rightClicked = (): Element | null =>
      Date.now() - lastRightClickedAt <= RIGHT_CLICK_TTL_MS ? lastRightClicked : null;

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      const m = msg as TabRequest;
      if (m?.type === 'sifter:hideTarget') {
        sendResponse({ ok: live.hideContaining(rightClicked()) });
      } else if (m?.type === 'sifter:getPageState') {
        sendResponse(live.state());
      } else if (m?.type === 'sifter:resetPerfPeaks') {
        live.resetPerfPeaks();
        sendResponse(live.state());
      } else if (m?.type === 'sifter:showAll') {
        live.showAll();
        sendResponse(live.state());
      } else if (m?.type === 'sifter:refresh') {
        refresh().then(
          () => sendResponse(live.state()),
          () => sendResponse(live.state()),
        );
        return true;
      }
      return false;
    });
  },
});
