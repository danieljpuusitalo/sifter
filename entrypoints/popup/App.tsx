import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { bg } from '../../src/bg';
import type { PageState, SiteContext, TabRequest } from '../../src/messages';
import { loadSettings, siteKey, type Settings } from '../../src/storage/settings';
import type { BlockCategory, HideCategory } from '../../src/types';

const CATEGORY_NAMES: Record<HideCategory, [string, string]> = {
  sponsored: ['sponsored post', 'sponsored posts'],
  suggested: ['suggestion', 'suggestions'],
  affiliate: ['affiliate post', 'affiliate posts'],
  custom: ['post matching your filters', 'posts matching your filters'],
  manual: ['post you hid', 'posts you hid'],
};

/** The per-site switches, in the order an ad blocker lists its filter lists. */
const BLOCK_ROWS: { cat: BlockCategory; label: string; needsSuggest?: boolean }[] = [
  { cat: 'sponsored', label: 'Sponsored posts and ads' },
  { cat: 'suggested', label: 'Suggested posts', needsSuggest: true },
  { cat: 'custom', label: 'My filters' },
];

type Tab = { id: number; url: string | undefined };

type View =
  | { kind: 'loading' }
  | { kind: 'running'; tab: Tab; state: PageState; settings: Settings }
  | { kind: 'available'; tab: Tab; hostname: string } // http(s) page without the content script
  | { kind: 'unsupported' };

const toTab = <T,>(tabId: number, msg: TabRequest) => browser.tabs.sendMessage(tabId, msg) as Promise<T>;

async function activeTab(): Promise<Tab | null> {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  return t?.id !== undefined ? { id: t.id, url: t.url } : null;
}

async function loadView(): Promise<View> {
  const tab = await activeTab();
  if (!tab) return { kind: 'unsupported' };
  try {
    const [state, settings] = await Promise.all([toTab<PageState>(tab.id, { type: 'sifter:getPageState' }), loadSettings()]);
    if (state) return { kind: 'running', tab, state, settings };
  } catch {
    /* no content script in this tab */
  }
  // tab.url is only visible for hosts we already have permission for (or via
  // activeTab once the popup is open). Anything else is not a page we can run on.
  if (tab.url && /^https:/.test(tab.url)) return { kind: 'available', tab, hostname: new URL(tab.url).hostname };
  return { kind: 'unsupported' };
}

export function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);

  const reload = () => loadView().then(setView, (e: unknown) => setError(String(e)));
  useEffect(() => void reload(), []);

  if (view.kind === 'loading') return <main class="popup" />;
  return (
    <main class="popup">
      <header class="top">
        <h1>
          <img src="/icon/32.png" width="16" height="16" alt="" /> Sifter
        </h1>
        <button class="link" onClick={() => void browser.runtime.openOptionsPage()}>
          Settings
        </button>
      </header>
      {view.kind === 'running' && (
        <Running tab={view.tab} state={view.state} settings={view.settings} onChange={reload} onError={setError} />
      )}
      {view.kind === 'available' && <Available tab={view.tab} hostname={view.hostname} onChange={reload} onError={setError} />}
      {view.kind === 'unsupported' && <p class="muted">Sifter can't run on this page.</p>}
      {error && <p class="error">{error}</p>}
      <footer class="foot muted">Labels only, no AI. Nothing leaves your browser.</footer>
    </main>
  );
}

function Running(props: { tab: Tab; state: PageState; settings: Settings; onChange: () => void; onError: (e: string) => void }) {
  const { tab, state, settings } = props;
  const entries = Object.entries(state.counts).filter(([, n]) => n > 0) as [HideCategory, number][];
  const total = entries.reduce((a, [, n]) => a + n, 0);

  const run = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
      await toTab(tab.id, { type: 'sifter:refresh' });
      props.onChange();
    } catch (e) {
      props.onError(`Couldn't ${what}: ${String(e)}`);
    }
  };
  const toggleSite = (enabled: boolean) =>
    run(() => bg<SiteContext>({ type: 'sifter:setSiteEnabled', hostname: state.siteKey, enabled }), 'change this site');
  const toggleCategory = (category: BlockCategory, value: boolean) =>
    run(() => bg<SiteContext>({ type: 'sifter:setSiteCategory', hostname: state.siteKey, category, value }), 'change this setting');
  const pause = (minutes: number | null) => run(() => bg({ type: 'sifter:pause', minutes }), 'pause');
  const showAll = async () => {
    try {
      await toTab(tab.id, { type: 'sifter:showAll' });
      props.onChange();
    } catch (e) {
      props.onError(`Couldn't show hidden posts: ${String(e)}`);
    }
  };

  const siteCats = settings.sites[state.siteKey]?.categories ?? {};

  return (
    <>
      <label class="switch site">
        <input type="checkbox" checked={state.enabled} onChange={(e) => void toggleSite((e.currentTarget as HTMLInputElement).checked)} />
        <span>
          <strong>{state.siteKey}</strong>
          <span class="muted">{state.enabled ? (state.paused ? ' · paused' : ' · on') : ' · off'}</span>
        </span>
      </label>

      {state.enabled && (
        <section class="counts" aria-live="polite">
          {state.paused ? (
            <p>Paused. Nothing is hidden until you resume.</p>
          ) : total === 0 ? (
            <p class="muted">Nothing hidden on this page yet.</p>
          ) : (
            <>
              <p class="big">
                <strong>{total}</strong> hidden on this page
              </p>
              <ul>
                {entries.map(([cat, n]) => (
                  <li key={cat}>
                    {n} {CATEGORY_NAMES[cat][n === 1 ? 0 : 1]}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {state.enabled && (
        <section class="blocks">
          <h2>Block on this site</h2>
          {BLOCK_ROWS.filter((r) => !r.needsSuggest || state.canSuggest).map((r) => {
            const custom = siteCats[r.cat] !== undefined;
            return (
              <label key={r.cat} class="switch">
                <input
                  type="checkbox"
                  checked={state.categories[r.cat]}
                  onChange={(e) => void toggleCategory(r.cat, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span>
                  {r.label}
                  {custom && <span class="muted small"> · this site only</span>}
                </span>
              </label>
            );
          })}
        </section>
      )}

      {state.enabled && (
        <div class="actions">
          {state.paused ? (
            <button onClick={() => void pause(null)}>Resume</button>
          ) : (
            <button onClick={() => void pause(60)}>Pause for 1 hour</button>
          )}
          {state.hiddenNow > 0 && <button onClick={() => void showAll()}>Show hidden ({state.hiddenNow})</button>}
        </div>
      )}
      {state.enabled && <p class="muted small">Missed one? Right-click it and choose "Hide this post with Sifter".</p>}
    </>
  );
}

function Available(props: { tab: Tab; hostname: string; onChange: () => void; onError: (e: string) => void }) {
  const key = siteKey(props.hostname);
  // The real host, not the settings key: an alias (google.de) folds into another
  // site's key, but the permission has to cover the page actually open.
  const host = props.hostname.toLowerCase().replace(/^www\./, '');
  const enable = async () => {
    try {
      // Must run inside the click handler: permission requests need a user gesture.
      const granted = await browser.permissions.request({ origins: [`https://${host}/*`, `https://www.${host}/*`] });
      if (!granted) {
        props.onError(`Sifter needs access to ${host} to hide anything there. Nothing changed.`);
        return;
      }
      await bg({ type: 'sifter:setSiteEnabled', hostname: props.hostname, enabled: true });
      await browser.scripting.executeScript({ target: { tabId: props.tab.id }, files: ['/content-scripts/content.js'] });
      props.onChange();
    } catch (e) {
      props.onError(`Couldn't turn Sifter on here: ${String(e)}`);
    }
  };
  return (
    <>
      <p>Sifter isn't on for {key}. It will look for posts labelled as ads and hide them.</p>
      <div class="actions">
        <button class="primary" onClick={() => void enable()}>
          Hide ads on {key}
        </button>
      </div>
    </>
  );
}
