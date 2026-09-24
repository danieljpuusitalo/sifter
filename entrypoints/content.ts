import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { adapterFor } from '../src/adapters';
import { Scanner } from '../src/content/scanner';
import type { BgRequest, SiteContext, TabRequest } from '../src/messages';
import { LAUNCH_MATCHES } from '../src/sites';

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
    const context = await send<SiteContext>({ type: 'sifter:getContext', hostname });

    const scanner = new Scanner({
      doc: document,
      hostname,
      baseUrl: location.href,
      adapter: adapterFor(hostname),
      context,
      persistOverride: (fp, action) => void send({ type: 'sifter:setOverride', hostname, fp, action }),
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
      const ctx = await send<SiteContext>({ type: 'sifter:getContext', hostname });
      scanner.applyContext(ctx);
      // Answer with the re-decided page, not a half-done one; but never hang the popup.
      await Promise.race([scanner.settled(), new Promise((r) => setTimeout(r, SETTLE_CAP_MS))]);
      clearTimeout(resumeTimer);
      if (ctx.pausedUntil !== null && ctx.pausedUntil > Date.now()) {
        resumeTimer = setTimeout(() => void refresh(), ctx.pausedUntil - Date.now() + 50);
      }
    };
    if (context.pausedUntil !== null && context.pausedUntil > Date.now()) void refresh();

    // The context menu's click reaches the service worker, not the page, so remember
    // what was right-clicked. Passive and capture-phase: it never touches the event.
    let lastRightClicked: Element | null = null;
    document.addEventListener(
      'contextmenu',
      (e) => {
        lastRightClicked = e.target instanceof Element ? e.target : null;
      },
      { capture: true, passive: true },
    );

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      const m = msg as TabRequest;
      if (m?.type === 'sifter:hideTarget') {
        sendResponse({ ok: scanner.hideContaining(lastRightClicked) });
      } else if (m?.type === 'sifter:getPageState') {
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
