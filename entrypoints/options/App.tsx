import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { bg } from '../../src/bg';
import { MAX_WORDS, parseRules } from '../../src/rules/filters';
import { LAUNCH_SITES } from '../../src/sites';
import {
  clearOverrides,
  exportBackup,
  importBackup,
  isSiteEnabled,
  loadOverrides,
  loadSettings,
  siteCategories,
  type Overrides,
  type Settings,
} from '../../src/storage/settings';
import type { BlockCategory, HideMode } from '../../src/types';

// The options page, laid out like an ad blocker's: what to block (the "filter
// lists"), where, the user's own filters, and the exceptions they've made.

const CATEGORIES: { cat: BlockCategory; label: string; short: string; hint: string }[] = [
  {
    cat: 'sponsored',
    label: 'Sponsored posts and ads',
    short: 'Ads',
    hint: 'Posts and results the site itself labels as sponsored, promoted or an ad.',
  },
  {
    cat: 'suggested',
    label: 'Suggested posts',
    short: 'Suggested',
    hint: 'Posts from accounts you don\'t follow that the site recommends, and "Who to follow" boxes. Not ads, so off by default.',
  },
  {
    cat: 'custom',
    label: 'My filters',
    short: 'My filters',
    hint: 'Your muted words and element rules, below.',
  },
];

const HIDE_MODES: { value: HideMode; label: string; hint: string }[] = [
  { value: 'collapse', label: 'Collapse', hint: 'Replace the post with a one-line note you can open.' },
  { value: 'blur', label: 'Blur', hint: 'Keep the post in place, blurred, with the same note above it.' },
  { value: 'hide', label: 'Hide completely', hint: 'No trace in the feed. Use "Show hidden" in the popup to bring posts back.' },
];


/** A real backup is a few kilobytes; refuse anything that could stall the page. */
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

function validCss(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** Muted words as typed: one per line or comma-separated. */
function parseWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.split(/[\n,]/)) {
    const t = w.trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, MAX_WORDS);
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [overrides, setOverrides] = useState<Overrides>({});
  const reload = () => Promise.all([loadSettings(), loadOverrides()]).then(([s, o]) => (setSettings(s), setOverrides(o)));
  useEffect(() => {
    void reload();
    // The popup or a page's "Not an ad" can change storage while this tab is open.
    const onChanged = () => void reload();
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  if (!settings) return <main class="options" />;

  return (
    <main class="options">
      <header>
        <h1>
          <img src="/icon/48.png" width="28" height="28" alt="" /> Sifter
        </h1>
        <p class="lede">Hides the ads your ad blocker misses: sponsored posts and promoted results inside the feed.</p>
      </header>

      <section>
        <h2>What to block</h2>
        <p class="muted small">These apply everywhere. Any site can override them in its row below or from the popup.</p>
        <ul class="cards">
          {CATEGORIES.map((c) => (
            <li key={c.cat}>
              <label class="switch">
                <input
                  type="checkbox"
                  checked={settings.categories[c.cat]}
                  onChange={(e) => {
                    const on = (e.currentTarget as HTMLInputElement).checked;
                    void bg<Settings>({ type: 'sifter:setCategory', category: c.cat, value: on }).then(setSettings);
                  }}
                />
                <span>
                  <strong>{c.label}</strong>
                  <span class="muted small block">{c.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <Sites settings={settings} onChange={reload} />

      <Filters settings={settings} onSaved={setSettings} />

      <section>
        <h2>How hidden posts look</h2>
        <fieldset class="modes">
          <legend class="sr-only">How hidden posts look</legend>
          {HIDE_MODES.map((m) => (
            <label key={m.value} class="mode">
              <input
                type="radio"
                name="hideMode"
                checked={settings.hideMode === m.value}
                onChange={() => void bg<Settings>({ type: 'sifter:setHideMode', mode: m.value }).then(setSettings)}
              />
              <span>
                <strong>{m.label}</strong>
                <span class="muted"> {m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <Exceptions overrides={overrides} onChange={reload} />

      <Backup onChange={reload} />

      <section>
        <h2>Privacy</h2>
        <p class="muted small">
          Sifter decides from the labels the site already shows, inside your browser. It has no server, no analytics and
          no account, and it makes no network requests of its own. Your settings stay in this browser's extension storage.
        </p>
      </section>
    </main>
  );
}

function Sites(props: { settings: Settings; onChange: () => void }) {
  const { settings } = props;
  const keys = [...LAUNCH_SITES.map((s) => s.key), ...settings.optInHosts.filter((h) => !LAUNCH_SITES.some((s) => s.key === h))];
  const nameOf = (key: string) => LAUNCH_SITES.find((s) => s.key === key)?.name ?? key;
  const launch = (key: string) => LAUNCH_SITES.some((s) => s.key === key);

  const setEnabled = (key: string, enabled: boolean) =>
    void bg({ type: 'sifter:setSiteEnabled', hostname: key, enabled }).then(props.onChange);
  const setCategory = (key: string, category: BlockCategory, value: string) =>
    void bg({ type: 'sifter:setSiteCategory', hostname: key, category, value: value === 'default' ? null : value === 'on' }).then(
      props.onChange,
    );

  return (
    <section>
      <h2>Sites</h2>
      <div class="table-wrap">
        <table class="sites">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">On</th>
              {CATEGORIES.map((c) => (
                <th key={c.cat} scope="col">
                  {c.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const on = isSiteEnabled(settings, key, launch(key));
              const own = settings.sites[key]?.categories ?? {};
              const eff = siteCategories(settings, key);
              return (
                <tr key={key} class={on ? '' : 'off'}>
                  <th scope="row">
                    {nameOf(key)}
                    {!launch(key) && <span class="muted small block">added by you</span>}
                  </th>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Sifter on ${nameOf(key)}`}
                      checked={on}
                      onChange={(e) => setEnabled(key, (e.currentTarget as HTMLInputElement).checked)}
                    />
                  </td>
                  {CATEGORIES.map((c) => (
                    <td key={c.cat}>
                      <select
                        aria-label={`${c.label} on ${nameOf(key)}`}
                        disabled={!on}
                        value={own[c.cat] === undefined ? 'default' : own[c.cat] ? 'on' : 'off'}
                        onChange={(e) => setCategory(key, c.cat, (e.currentTarget as HTMLSelectElement).value)}
                      >
                        <option value="default">Default ({settings.categories[c.cat] ? 'on' : 'off'})</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                      <span class="sr-only">{eff[c.cat] ? 'blocking' : 'not blocking'}</span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        To add another site, open it and choose "Hide ads on this site" in the Sifter popup. Sites you add use general
        detection: they look for elements whose whole text is "Sponsored", "Ad" or similar.
      </p>
    </section>
  );
}

function Filters(props: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [words, setWords] = useState(props.settings.mutedWords.join('\n'));
  const [rules, setRules] = useState(props.settings.rulesText);
  const [status, setStatus] = useState<string | null>(null);
  const parsed = useMemo(() => parseRules(rules, validCss), [rules]);
  const wordList = useMemo(() => parseWords(words), [words]);
  const storedWords = props.settings.mutedWords.join('\n');
  const storedRules = props.settings.rulesText;
  const dirty = words !== storedWords || rules !== storedRules;

  // Stored filters changed underneath (an import, another options window): take
  // them, unless the user has unsaved edits here, which the dirty marker shows.
  const prevStored = useRef({ words: storedWords, rules: storedRules });
  useEffect(() => {
    const prev = prevStored.current;
    if (words === prev.words && rules === prev.rules) {
      setWords(storedWords);
      setRules(storedRules);
    }
    prevStored.current = { words: storedWords, rules: storedRules };
  }, [storedWords, storedRules]);

  const submit = async (e: Event) => {
    e.preventDefault();
    const next = await bg<Settings>({ type: 'sifter:setFilters', mutedWords: wordList, rulesText: rules });
    props.onSaved(next);
    setWords(wordList.join('\n'));
    setStatus(`Saved. ${wordList.length} muted word${wordList.length === 1 ? '' : 's'}, ${parsed.rules.length} rule${parsed.rules.length === 1 ? '' : 's'}.`);
  };

  return (
    <section>
      <h2>My filters</h2>
      <form class="filters" onSubmit={(e) => void submit(e)}>
        <label class="field">
          <strong>Muted words</strong>
          <span class="muted small">
            Hide any post that contains one of these words or phrases. One per line. Whole words only, so "cat" doesn't
            hide "education".
          </span>
          <textarea rows={5} spellcheck={false} value={words} placeholder={'crypto\nweight loss\ngiveaway'} onInput={(e) => (setWords((e.currentTarget as HTMLTextAreaElement).value), setStatus(null))} />
        </label>
        <label class="field">
          <strong>Element rules</strong>
          <span class="muted small">
            Hide page elements by CSS selector, in the same form ad blockers use: <code>site##selector</code>, or{' '}
            <code>##selector</code> for every site Sifter runs on. Lines starting with <code>!</code> are comments.
          </span>
          <textarea
            rows={5}
            spellcheck={false}
            class="mono"
            value={rules}
            placeholder={'! Example\nlinkedin.com##aside[aria-label="Add to your feed"]'}
            onInput={(e) => (setRules((e.currentTarget as HTMLTextAreaElement).value), setStatus(null))}
          />
        </label>
        {parsed.errors.length > 0 && (
          <ul class="errors" aria-live="polite">
            {parsed.errors.slice(0, 10).map((err) => (
              <li key={err.line} class="error small">
                Line {err.line}: {err.reason}. This line is ignored.
              </li>
            ))}
          </ul>
        )}
        <div class="actions">
          <button class="primary" type="submit" disabled={!dirty}>
            Save filters
          </button>
          {status && <span class="muted small" role="status">{status}</span>}
        </div>
      </form>
    </section>
  );
}

function Exceptions(props: { overrides: Overrides; onChange: () => void }) {
  const rows = Object.entries(props.overrides)
    .map(([key, fps]) => {
      const vals = Object.values(fps);
      return { key, shown: vals.filter((v) => v === 'not-ad').length, hidden: vals.filter((v) => v === 'hide').length };
    })
    .filter((r) => r.shown + r.hidden > 0);
  const clear = (key: string | null) => void clearOverrides(key).then(props.onChange);
  return (
    <section>
      <h2>Your exceptions</h2>
      <p class="muted small">
        Posts you marked "Not an ad" or "Always show", and posts you hid yourself. Sifter remembers them by a fingerprint of
        the post's text, not the text itself.
      </p>
      {rows.length === 0 ? (
        <p class="muted">None yet.</p>
      ) : (
        <>
          <ul class="exceptions">
            {rows.map((r) => (
              <li key={r.key}>
                <span>
                  <strong>{r.key}</strong>
                  <span class="muted small">
                    {' '}
                    {r.shown} always shown · {r.hidden} hidden by you
                  </span>
                </span>
                <button onClick={() => clear(r.key)}>Clear</button>
              </li>
            ))}
          </ul>
          <div class="actions">
            <button onClick={() => clear(null)}>Clear all exceptions</button>
          </div>
        </>
      )}
    </section>
  );
}

function Backup(props: { onChange: () => void }) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const doExport = async () => {
    const data = await exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `sifter-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus({ ok: true, text: 'Backup saved to your downloads.' });
  };
  const doImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      setStatus({ ok: false, text: "That file is too big to be a Sifter backup." });
      return;
    }
    try {
      await importBackup(JSON.parse(await file.text()));
      setStatus({ ok: true, text: 'Settings restored.' });
      props.onChange();
    } catch (e) {
      setStatus({ ok: false, text: e instanceof SyntaxError ? "That file isn't valid JSON." : (e as Error).message });
    }
  };
  return (
    <section>
      <h2>Backup</h2>
      <p class="muted small">Your settings, filters and exceptions as one file, to move to another browser or keep safe.</p>
      <div class="actions">
        <button onClick={() => void doExport()}>Export settings</button>
        <label class="button">
          Import settings
          <input
            type="file"
            accept="application/json,.json"
            class="sr-only"
            onChange={(e) => {
              const input = e.currentTarget as HTMLInputElement;
              void doImport(input.files?.[0]).finally(() => (input.value = ''));
            }}
          />
        </label>
        {status && (
          <span class={status.ok ? 'muted small' : 'error small'} role="status">
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}
