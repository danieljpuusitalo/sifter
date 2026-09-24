import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { ADAPTERS } from '../../src/adapters';
import { isSiteEnabled, loadSettings, updateSettings, type Settings } from '../../src/storage/settings';
import type { HideMode } from '../../src/types';

// M1: labels-only. Provider setup (on-device model, bring your own key) lands in M2.

const HIDE_MODES: { value: HideMode; label: string; hint: string }[] = [
  { value: 'collapse', label: 'Collapse', hint: 'Replace the post with a one-line note you can open.' },
  { value: 'blur', label: 'Blur', hint: 'Keep the post in place, blurred, with the same note above it.' },
  { value: 'hide', label: 'Hide completely', hint: 'No trace in the feed. Use "Show hidden" in the popup to bring posts back.' },
];

const LAUNCH_SITE_KEYS = ['linkedin.com', 'reddit.com', 'google.com'];

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => void loadSettings().then(setSettings), []);
  if (!settings) return <main class="options" />;

  const save = async (fn: (s: Settings) => Settings) => setSettings(await updateSettings(fn));
  const optIn = settings.optInHosts;

  return (
    <main class="options">
      <h1>Sifter</h1>
      <p class="lede">Hides the ads your ad blocker misses: sponsored posts and promoted results that sit inside the feed.</p>

      <section>
        <h2>How Sifter decides</h2>
        <div class="paths">
          <div class="path current">
            <h3>Labels only</h3>
            <p>Works now, with no AI. Sifter hides posts the site itself labels as sponsored or promoted. Nothing leaves your browser.</p>
            <p class="state">In use</p>
          </div>
          <div class="path">
            <h3>Free on-device AI</h3>
            <p>Chrome's built-in model also catches unlabelled promotion and your own filters. One-time download.</p>
            <p class="state muted">Not available yet</p>
          </div>
          <div class="path">
            <h3>Bring your own key</h3>
            <p>Use Anthropic or any OpenAI-compatible provider, with a daily spending cap.</p>
            <p class="state muted">Not available yet</p>
          </div>
        </div>
        <p class="muted small">
          With AI switched on, Sifter sends only the short text of posts near your screen and the names of the sites they
          link to, and only to the provider you choose. Never page addresses, form contents or cookies. There is no Sifter
          server.
        </p>
      </section>

      <section>
        <h2>Hidden posts</h2>
        <fieldset class="modes">
          <legend class="sr-only">How hidden posts look</legend>
          {HIDE_MODES.map((m) => (
            <label key={m.value} class="mode">
              <input
                type="radio"
                name="hideMode"
                checked={settings.hideMode === m.value}
                onChange={() => void save((s) => ({ ...s, hideMode: m.value }))}
              />
              <span>
                <strong>{m.label}</strong>
                <span class="muted"> {m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <section>
        <h2>Sites</h2>
        <ul class="sites">
          {[...LAUNCH_SITE_KEYS, ...optIn].map((key) => {
            const launch = LAUNCH_SITE_KEYS.includes(key);
            const on = isSiteEnabled(settings, key, launch);
            return (
              <li key={key}>
                <label class="switch">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const enabled = (e.currentTarget as HTMLInputElement).checked;
                      void browser.runtime
                        .sendMessage({ type: 'sifter:setSiteEnabled', hostname: key, enabled })
                        .then(() => loadSettings().then(setSettings));
                    }}
                  />
                  <span>{key}</span>
                </label>
                <span class="muted small">{launch ? 'Built in' : 'Your site, general detection'}</span>
              </li>
            );
          })}
        </ul>
        <p class="muted small">
          To add a site, open it and choose "Hide ads on this site" in the Sifter popup. Built-in rules exist for{' '}
          {ADAPTERS.map((a) => a.id).join(', ')}.
        </p>
      </section>
    </main>
  );
}
