import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { adapterFor } from '../src/adapters';
import { Scanner } from '../src/content/scanner';
import { defaultContext, type BgRequest, type SiteContext, type TabRequest } from '../src/messages';
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

/** How long a refresh waits for the re-decide to finish before answering the popup. */
const SETTLE_CAP_MS = 1000;

export default defineContentScript({
  matches: LAUNCH_MATCHES,
  runAt: 'document_idle',
  async main() {
    // The popup can inject this script into a tab that already has it.
    const probe: Probe = { alive: false };
    document.dispatchEvent(new CustomEvent<Probe>(PROBE_EVENT, { detail: probe }));
    if (probe.alive) return;

    const hostname = location.hostname;
    const send = <T>(msg: BgRequest) => browser.runtime.sendMessage(msg) as Promise<T>;
    const context = await withRetry(() => send<SiteContext>({ type: 'sifter:getContext', hostname }), CONTEXT_RETRY_DELAYS_MS).catch(
      (e: unknown) => {
        console.warn('[sifter] could not load settings', e);
        return defaultContext(hostname);
      },
    );

    const scanner = new Scanner({
      doc: document,
      hostname,
      baseUrl: location.href,
      adapter: adapterFor(hostname),
      context,
      persistOverride: (fp, action) =>
        void send({ type: 'sifter:setOverride', hostname, fp, action }).catch(() => undefined),
      dev: import.meta.env.DEV,
    });
    scanner.start();

    const onProbe = (e: Event) => {
      const detail = (e as CustomEvent<Probe | null>).detail;
      if (!detail) return; // not from one of our own instances
      if (browser.runtime?.id) {
        detail.alive = true;
        return;
      }
      document.removeEventListener(PROBE_EVENT, onProbe);
      scanner.stop();
    };
    document.addEventListener(PROBE_EVENT, onProbe);

    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const ctx = await withRetry(() => send<SiteContext>({ type: 'sifter:getContext', hostname }), CONTEXT_RETRY_DELAYS_MS);
      scanner.applyContext(ctx);
      // Answer with the re-decided page, not a half-done one; but never hang the popup.
      await Promise.race([scanner.settled(), new Promise((r) => setTimeout(r, SETTLE_CAP_MS))]);
      clearTimeout(resumeTimer);
      if (ctx.pausedUntil !== null && ctx.pausedUntil > Date.now()) {
        resumeTimer = setTimeout(() => void refresh().catch(() => undefined), ctx.pausedUntil - Date.now() + 50);
      }
    };
    if (context.pausedUntil !== null && context.pausedUntil > Date.now()) void refresh().catch(() => undefined);

    // bfcache restores the page (and this script) without a fresh document_idle
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
        sendResponse({ ok: scanner.hideContaining(rightClicked()) });
      } else if (m?.type === 'sifter:getPageState') {
        sendResponse(scanner.state());
      } else if (m?.type === 'sifter:resetPerfPeaks') {
        scanner.resetPerfPeaks();
        sendResponse(scanner.state());
      } else if (m?.type === 'sifter:showAll') {
        scanner.showAll();
        sendResponse(scanner.state());
      } else if (m?.type === 'sifter:refresh') {
        refresh().then(
          () => sendResponse(scanner.state()),
          () => sendResponse(scanner.state()),
        );
        return true;
      }
      return false;
    });
  },
});
