import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { adapterFor } from '../src/adapters';
import { Scanner } from '../src/content/scanner';
import type { BgRequest, SiteContext, TabRequest } from '../src/messages';
import { LAUNCH_MATCHES } from '../src/sites';

declare global {
  interface Window {
    __siftLoaded?: boolean;
  }
}

export default defineContentScript({
  matches: LAUNCH_MATCHES,
  runAt: 'document_idle',
  async main() {
    // The popup can inject this script into a tab that already has it.
    if (window.__siftLoaded) return;
    window.__siftLoaded = true;

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

    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const ctx = await send<SiteContext>({ type: 'sifter:getContext', hostname });
      scanner.applyContext(ctx);
      clearTimeout(resumeTimer);
      if (ctx.pausedUntil !== null && ctx.pausedUntil > Date.now()) {
        resumeTimer = setTimeout(() => void refresh(), ctx.pausedUntil - Date.now() + 50);
      }
    };
    if (context.pausedUntil !== null && context.pausedUntil > Date.now()) void refresh();

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      const m = msg as TabRequest;
      if (m?.type === 'sifter:getPageState') {
        sendResponse(scanner.state());
      } else if (m?.type === 'sifter:showAll') {
        scanner.showAll();
        sendResponse(scanner.state());
      } else if (m?.type === 'sifter:refresh') {
        refresh().then(() => sendResponse(scanner.state()));
        return true;
      }
      return false;
    });
  },
});
