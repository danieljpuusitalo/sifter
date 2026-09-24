import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { adapterFor } from '../src/adapters';
import { isBgRequest, type BgRequest, type SiteContext } from '../src/messages';
import {
  isSiteEnabled,
  loadOverrides,
  loadSettings,
  setOverride,
  siteKey,
  updateSettings,
} from '../src/storage/settings';

const OPT_IN_SCRIPT_ID = 'sifter-opt-in';

export default defineBackground(() => {
  // Hard rule 4: content scripts must never be able to read stored API keys.
  // Lock storage.local to trusted contexts; content scripts go through messages.
  void browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void browser.runtime.openOptionsPage();
    void syncOptInScripts();
  });
  browser.runtime.onStartup.addListener(() => void syncOptInScripts());

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isBgRequest(msg)) return false;
    handle(msg).then(sendResponse, (err: unknown) => sendResponse({ error: String(err) }));
    return true; // async response
  });
});

async function handle(msg: BgRequest): Promise<unknown> {
  switch (msg.type) {
    case 'sifter:getContext':
      return getContext(msg.hostname);
    case 'sifter:setOverride':
      await setOverride(siteKey(msg.hostname), msg.fp, msg.action);
      return { ok: true };
    case 'sifter:setSiteEnabled': {
      const key = siteKey(msg.hostname);
      const isLaunch = adapterFor(msg.hostname) !== null;
      await updateSettings((s) => ({
        ...s,
        sites: { ...s.sites, [key]: { enabled: msg.enabled } },
        optInHosts:
          isLaunch || !msg.enabled || s.optInHosts.includes(key) ? s.optInHosts : [...s.optInHosts, key],
      }));
      await syncOptInScripts();
      return getContext(msg.hostname);
    }
    case 'sifter:pause':
      await updateSettings((s) => ({
        ...s,
        pausedUntil: msg.minutes === null ? null : Date.now() + msg.minutes * 60_000,
      }));
      return { ok: true };
  }
}

async function getContext(hostname: string): Promise<SiteContext> {
  const key = siteKey(hostname);
  const [settings, overrides] = await Promise.all([loadSettings(), loadOverrides()]);
  return {
    siteKey: key,
    enabled: isSiteEnabled(settings, key, adapterFor(hostname) !== null),
    pausedUntil: settings.pausedUntil,
    hideMode: settings.hideMode,
    overrides: overrides[key] ?? {},
  };
}

/**
 * Sites the user switched on from the popup get the content script through
 * chrome.scripting.registerContentScripts (BRIEF.md §5 "Permissions"). Rebuilt
 * from settings each time so storage stays the single source of truth.
 */
async function syncOptInScripts(): Promise<void> {
  const settings = await loadSettings();
  const hosts = settings.optInHosts.filter((h) => settings.sites[h]?.enabled !== false);
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [OPT_IN_SCRIPT_ID] });
  if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [OPT_IN_SCRIPT_ID] });
  if (hosts.length === 0) return;
  const granted = await browser.permissions.getAll();
  const origins = new Set(granted.origins ?? []);
  const matches = hosts
    .flatMap((h) => [`https://${h}/*`, `https://www.${h}/*`])
    .filter((m) => origins.has(m) || origins.has('https://*/*'));
  if (matches.length === 0) return;
  await browser.scripting.registerContentScripts([
    { id: OPT_IN_SCRIPT_ID, js: ['content-scripts/content.js'], matches, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}
