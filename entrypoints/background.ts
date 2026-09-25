import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { isBgRequest, type BgRequest, type SiteContext, type TabRequest } from '../src/messages';
import { parseRules, selectorsFor } from '../src/rules/filters';
import { HOSTNAME_RE, injectTargetMatches, isLaunchHost, LAUNCH_MATCHES, LAUNCH_SITES, optInScriptMatches } from '../src/sites';
import {
  isSiteEnabled,
  loadOverrides,
  loadSettings,
  setOverride,
  siteCategories,
  siteOffRules,
  siteKey,
  updateSettings,
} from '../src/storage/settings';

const OPT_IN_SCRIPT_ID = 'sifter-opt-in';
const MENU_ID = 'sifter-hide-this';

/** Fingerprints are cyrb53(...).toString(36): base-36, at most 11 digits in practice. */
const FINGERPRINT_RE = /^[0-9a-z]{1,16}$/;

/** Content scripts may only read their own site's context and record overrides for it. */
const CONTENT_SCRIPT_REQUESTS = new Set<BgRequest['type']>(['sifter:getContext', 'sifter:setOverride']);

export default defineBackground(() => {
  // Hard rule 4: content scripts must never be able to read stored API keys.
  // Lock storage.local to trusted contexts; content scripts go through messages.
  browser.storage.local
    .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch((e: unknown) => console.warn('[sifter] could not lock storage to trusted contexts', e));

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') browser.runtime.openOptionsPage().catch(() => undefined);
    // Menus persist across restarts; recreate on install/update only.
    browser.contextMenus
      .removeAll()
      .then(() => {
        browser.contextMenus.create({
          id: MENU_ID,
          title: 'Hide this post with Sifter',
          contexts: ['page', 'link', 'image', 'video', 'selection'],
          documentUrlPatterns: LAUNCH_MATCHES,
        });
      })
      .then(() => syncOptInScripts())
      .then((optInMatches) => injectIntoOpenTabs(injectTargetMatches(optInMatches)))
      .catch((e: unknown) => console.warn('[sifter] install setup failed', e));
  });
  browser.runtime.onStartup.addListener(() => void syncOptInScripts());
  // Granting or revoking a site in chrome://extensions changes where the script may run.
  browser.permissions.onAdded.addListener(() => void syncOptInScripts());
  browser.permissions.onRemoved.addListener(() => void syncOptInScripts());

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
    const msg: TabRequest = { type: 'sifter:hideTarget' };
    void browser.tabs.sendMessage(tab.id, msg, { frameId: info.frameId ?? 0 }).catch(() => undefined);
  });

  // Settings changed anywhere (options page, popup, an imported backup, another
  // tab's "Not an ad"): re-register opt-in scripts, then tell open pages to
  // re-read their context, so a change applies without a reload.
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('settings' in changes || 'overrides' in changes)) return;
    const settingsChanged = 'settings' in changes;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      void (settingsChanged ? syncOptInScripts() : Promise.resolve()).then(broadcastRefresh);
    }, 150);
  });

  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isBgRequest(msg)) return false;
    const checked = authorize(msg, sender);
    if (!checked) {
      sendResponse({ error: 'not allowed' });
      return false;
    }
    handle(checked).then(sendResponse, (err: unknown) => sendResponse({ error: String(err) }));
    return true; // async response
  });
});

/**
 * Extension pages may send anything. A content script runs inside a site's page,
 * which could be compromised, so it may only ask about its own site: the hostname
 * comes from the sender's URL, never from the message.
 */
function authorize(msg: BgRequest, sender: Browser.runtime.MessageSender): BgRequest | null {
  if (sender.id !== browser.runtime.id) return null;
  if (sender.url?.startsWith(browser.runtime.getURL('/'))) return msg;
  if (!CONTENT_SCRIPT_REQUESTS.has(msg.type) || !sender.url) return null;
  let hostname: string;
  try {
    hostname = new URL(sender.url).hostname;
  } catch {
    return null;
  }
  return { ...msg, hostname } as BgRequest;
}

async function broadcastRefresh(): Promise<void> {
  const tabs = await browser.tabs.query({});
  const msg: TabRequest = { type: 'sifter:refresh' };
  // Tabs without the content script reject; that's expected.
  await Promise.all(tabs.map((t) => (t.id === undefined ? null : browser.tabs.sendMessage(t.id, msg).catch(() => undefined))));
}

/**
 * A host the manifest injects into, or a launch site's key (the options page
 * names sites by key). Anything else, old.reddit.com included, needs opting in.
 */
function isLaunch(hostname: string): boolean {
  return isLaunchHost(hostname) || LAUNCH_SITES.some((s) => s.key === hostname);
}

async function handle(msg: BgRequest): Promise<unknown> {
  switch (msg.type) {
    case 'sifter:getContext':
      return getContext(msg.hostname);
    case 'sifter:setOverride':
      if (!FINGERPRINT_RE.test(msg.fp) || (msg.action !== null && msg.action !== 'not-ad' && msg.action !== 'hide')) {
        return { error: 'invalid override' };
      }
      await setOverride(siteKey(msg.hostname), msg.fp, msg.action);
      return { ok: true };
    case 'sifter:setSiteEnabled': {
      const key = siteKey(msg.hostname);
      // Opt-in hosts become match patterns, so they keep the real hostname (minus
      // "www."), not the aliased key. The storage schema drops a malformed host on
      // the next load, but a bad match pattern would already have failed the
      // registration below, so reject it before it is stored at all.
      const host = msg.hostname.toLowerCase().replace(/^www\./, '');
      if (!HOSTNAME_RE.test(host)) return { error: 'invalid hostname' };
      const optIn = !isLaunch(msg.hostname) && msg.enabled;
      await updateSettings((s) => ({
        ...s,
        sites: { ...s.sites, [key]: { ...s.sites[key], enabled: msg.enabled } },
        optInHosts: !optIn || s.optInHosts.includes(host) ? s.optInHosts : [...s.optInHosts, host],
      }));
      await syncOptInScripts();
      return getContext(msg.hostname);
    }
    case 'sifter:setSiteCategory': {
      const key = siteKey(msg.hostname);
      await updateSettings((s) => {
        const cats = { ...(s.sites[key]?.categories ?? {}) };
        // Setting a site back to the global value drops the override, so a later global change applies.
        if (msg.value === null || msg.value === s.categories[msg.category]) delete cats[msg.category];
        else cats[msg.category] = msg.value;
        return { ...s, sites: { ...s.sites, [key]: { ...s.sites[key], categories: cats } } };
      });
      return getContext(msg.hostname);
    }
    case 'sifter:setSiteRule': {
      const key = siteKey(msg.hostname);
      await updateSettings((s) => {
        const rules: Record<string, false> = { ...(s.sites[key]?.rules ?? {}) };
        if (msg.value) delete rules[msg.rule];
        else rules[msg.rule] = false;
        return { ...s, sites: { ...s.sites, [key]: { ...s.sites[key], rules } } };
      });
      return getContext(msg.hostname);
    }
    case 'sifter:pause':
      await updateSettings((s) => ({
        ...s,
        pausedUntil: msg.minutes === null ? null : Date.now() + msg.minutes * 60_000,
      }));
      return { ok: true };
    case 'sifter:setCategory':
      return updateSettings((s) => ({ ...s, categories: { ...s.categories, [msg.category]: msg.value } }));
    case 'sifter:setHideMode':
      return updateSettings((s) => ({ ...s, hideMode: msg.mode }));
    case 'sifter:setFilters':
      return updateSettings((s) => ({ ...s, mutedWords: msg.mutedWords, rulesText: msg.rulesText }));
  }
}

async function getContext(hostname: string): Promise<SiteContext> {
  const key = siteKey(hostname);
  const [settings, overrides] = await Promise.all([loadSettings(), loadOverrides()]);
  // No DOM in the service worker, so selectors are checked in the page (scanner) instead.
  const { rules } = parseRules(settings.rulesText, () => true);
  const optedIn = settings.optInHosts.includes(hostname.toLowerCase().replace(/^www\./, ''));
  return {
    siteKey: key,
    enabled: isSiteEnabled(settings, key, isLaunch(hostname) || optedIn),
    pausedUntil: settings.pausedUntil,
    hideMode: settings.hideMode,
    overrides: overrides[key] ?? {},
    categories: siteCategories(settings, key),
    customSelectors: selectorsFor(rules, key),
    mutedWords: settings.mutedWords,
    offRules: siteOffRules(settings, key),
  };
}

/**
 * Sites the user switched on from the popup get the content script through
 * chrome.scripting.registerContentScripts (BRIEF.md §5 "Permissions"). Rebuilt
 * from settings each time so storage stays the single source of truth. Calls are
 * chained: two overlapping syncs would race unregister against register.
 */
let syncChain: Promise<string[]> = Promise.resolve([]);
/** Resolves to the opt-in match patterns just (re)registered, so install/update
 * can inject into tabs that were already open for them. */
function syncOptInScripts(): Promise<string[]> {
  syncChain = syncChain.then(doSync).catch((e: unknown) => {
    console.warn('[sifter] opt-in sync failed', e);
    return [];
  });
  return syncChain;
}

async function doSync(): Promise<string[]> {
  const settings = await loadSettings();
  const hosts = settings.optInHosts.filter((h) => settings.sites[siteKey(h)]?.enabled !== false);
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [OPT_IN_SCRIPT_ID] });
  const granted = await browser.permissions.getAll();
  const matches = optInScriptMatches(hosts, granted.origins ?? []);
  // "Hide this post" belongs wherever the script runs.
  await browser.contextMenus.update(MENU_ID, { documentUrlPatterns: [...LAUNCH_MATCHES, ...matches] }).catch(() => undefined);
  if (matches.length === 0) {
    if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [OPT_IN_SCRIPT_ID] });
    return matches;
  }
  // Update in place rather than unregister-then-register: if the new pattern list
  // is refused, the previous registration stays and every other opt-in site keeps
  // its script, instead of all of them going dark until the next successful sync.
  const script = { id: OPT_IN_SCRIPT_ID, js: ['content-scripts/content.js'], matches, runAt: 'document_idle' as const, persistAcrossSessions: true };
  if (existing.length > 0) await browser.scripting.updateContentScripts([script]);
  else await browser.scripting.registerContentScripts([script]);
  return matches;
}

/**
 * Chrome never runs `content_scripts` (or newly registered opt-in scripts)
 * against tabs that were already open when the extension installed or updated,
 * so force it. Each tab is injected independently: a chrome:// tab, a discarded
 * tab, or one Sifter is already running in (the content script's probe guard
 * makes a second injection a no-op) all throw or no-op harmlessly.
 */
async function injectIntoOpenTabs(matches: string[]): Promise<void> {
  if (matches.length === 0) return;
  const tabs = await browser.tabs.query({ url: matches });
  await Promise.all(
    tabs
      .filter((t): t is Browser.tabs.Tab & { id: number } => t.id !== undefined)
      .map((t) =>
        browser.scripting
          .executeScript({ target: { tabId: t.id }, files: ['/content-scripts/content.js'] })
          .catch(() => undefined),
      ),
  );
}
