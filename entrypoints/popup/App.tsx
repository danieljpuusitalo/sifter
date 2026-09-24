import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { BgRequest, PageState, SiteContext, TabRequest } from '../../src/messages';
import { siteKey } from '../../src/storage/settings';
import type { HideCategory } from '../../src/types';

const CATEGORY_NAMES: Record<HideCategory, [string, string]> = {
  sponsored: ['sponsored post', 'sponsored posts'],
  affiliate: ['affiliate post', 'affiliate posts'],
  custom: ['post matching your filters', 'posts matching your filters'],
  manual: ['post you hid', 'posts you hid'],
};

type Tab = { id: number; url: string | undefined };

type View =
  | { kind: 'loading' }
  | { kind: 'running'; tab: Tab; state: PageState }
  | { kind: 'available'; tab: Tab; hostname: string } // http(s) page without the content script
  | { kind: 'unsupported' };

const bg = <T,>(msg: BgRequest) => browser.runtime.sendMessage(msg) as Promise<T>;
const toTab = <T,>(tabId: number, msg: TabRequest) => browser.tabs.sendMessage(tabId, msg) as Promise<T>;

async function activeTab(): Promise<Tab | null> {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  return t?.id !== undefined ? { id: t.id, url: t.url } : null;
}

async function loadView(): Promise<View> {
  const tab = await activeTab();
  if (!tab) return { kind: 'unsupported' };
  try {
    const state = await toTab<PageState>(tab.id, { type: 'sifter:getPageState' });
    if (state) return { kind: 'running', tab, state };
  } catch {
    /* no content script in this tab */
  }
  // tab.url is only visible for hosts we already have permission for, so an
  // unknown page shows up as undefined here. Ask via the permission prompt instead.
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
        <h1>Sifter</h1>
        <button class="link" onClick={() => void browser.runtime.openOptionsPage()}>
          Settings
        </button>
      </header>
      {view.kind === 'running' && <Running tab={view.tab} state={view.state} onChange={reload} onError={setError} />}
      {view.kind === 'available' && <Available tab={view.tab} hostname={view.hostname} onChange={reload} onError={setError} />}
      {view.kind === 'unsupported' && <p class="muted">Sifter can't run on this page.</p>}
      {error && <p class="error">{error}</p>}
      <footer class="provider muted">Labels only. No AI is set up, nothing leaves your browser.</footer>
    </main>
  );
}

function Running(props: { tab: Tab; state: PageState; onChange: () => void; onError: (e: string) => void }) {
  const { tab, state } = props;
  const entries = Object.entries(state.counts).filter(([, n]) => n > 0) as [HideCategory, number][];

  const toggle = async (enabled: boolean) => {
    try {
      await bg<SiteContext>({ type: 'sifter:setSiteEnabled', hostname: state.siteKey, enabled });
      await toTab(tab.id, { type: 'sifter:refresh' });
      props.onChange();
    } catch (e) {
      props.onError(`Couldn't change this site: ${String(e)}`);
    }
  };
  const pause = async (minutes: number | null) => {
    await bg({ type: 'sifter:pause', minutes });
    await toTab(tab.id, { type: 'sifter:refresh' });
    props.onChange();
  };
  const showAll = async () => {
    await toTab(tab.id, { type: 'sifter:showAll' });
    props.onChange();
  };

  return (
    <>
      <label class="switch">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => void toggle((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>{state.enabled ? `On for ${state.siteKey}` : `Off for ${state.siteKey}`}</span>
      </label>

      {state.enabled && (
        <section class="counts" aria-live="polite">
          {state.paused ? (
            <p>Paused. Nothing is hidden until you resume.</p>
          ) : entries.length === 0 ? (
            <p class="muted">Nothing hidden on this page yet.</p>
          ) : (
            <ul>
              {entries.map(([cat, n]) => (
                <li key={cat}>
                  <strong>{n}</strong> {CATEGORY_NAMES[cat][n === 1 ? 0 : 1]} hidden
                </li>
              ))}
            </ul>
          )}
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
    </>
  );
}

function Available(props: { tab: Tab; hostname: string; onChange: () => void; onError: (e: string) => void }) {
  const key = siteKey(props.hostname);
  const enable = async () => {
    // Must run inside the click handler: permission requests need a user gesture.
    const granted = await browser.permissions.request({ origins: [`https://${key}/*`, `https://www.${key}/*`] });
    if (!granted) {
      props.onError(`Sifter needs access to ${key} to hide anything there. Nothing changed.`);
      return;
    }
    await bg({ type: 'sifter:setSiteEnabled', hostname: props.hostname, enabled: true });
    await browser.scripting.executeScript({ target: { tabId: props.tab.id }, files: ['/content-scripts/content.js'] });
    props.onChange();
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
