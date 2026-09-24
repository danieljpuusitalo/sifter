# Sifter

Chrome MV3 extension that hides native sponsored units ad blockers miss, plus
plain-English filters. The spec is `BRIEF.md`; current state and next steps are in
`CHECKPOINT.md`. Work one milestone (BRIEF.md §9) per session, and do not start the
next until the current one's acceptance criteria pass.

## Commands

Use `pnpm` (installed globally). On this Windows machine, run from Git Bash or PowerShell.

| Command | What it does |
|---|---|
| `pnpm install` | install deps (runs `wxt prepare`) |
| `pnpm dev` | opens Chrome with the extension loaded, hot reload |
| `pnpm build` | production build to `.output/chrome-mv3` and a zip in `.output/` |
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm test` | Vitest unit tests (happy-dom), includes the fixture judge |
| `pnpm eval:mock` | runs the pipeline over `fixtures/public`, prints precision/recall, fails on any false hide or missed ad; writes `evals/results/` |
| `pnpm test:e2e` | builds, then Playwright against the built extension with fixtures served at the real site URLs; all other network is aborted |
| `pnpm bench:scroll` | builds, then scrolls a synthetic 600-card LinkedIn feed with the extension off vs on (4x CPU throttle); frame, layout and scanner counters. Args: `--start --seconds --runs --cpu` |
| `pnpm verify` | typecheck + test + eval:mock (what CI runs) |

First e2e run on a new machine: `pnpm exec playwright install chromium`.

`pnpm dev` needs `web-ext` (a devDependency; without it WXT silently prints "load manually"). Branded Chrome 137+ ignores `--load-extension`, so a gitignored `web-ext.config.ts` points `binaries.chrome` at Playwright's Chromium with a persistent `.dev-profile/` (create the folder first). Copy that pattern on a new machine.

## Hard rules (BRIEF.md §3, verbatim)

1. No backend, no servers, no analytics, no remote config. Everything runs in the browser.
2. No remote code. Model output is data: verdict JSON or CSS selector strings. Never `eval` it, never inject it as HTML or script, never assign it to `innerHTML`. Selectors are only passed to `querySelectorAll` inside try/catch and to generated CSS after validation (§5, tier 2).
3. Send the model candidate unit text only, capped per unit. Never full page HTML, form field values, cookies, or URLs with query strings.
4. API keys live in `chrome.storage.local` and are read only in the service worker. Content scripts, popup and options never receive a stored key back after saving it. Never log keys.
5. Never remove nodes from the page. Hide by adding a class and inline style to the unit root, so infinite scroll and site JS keep working. Every hide is reversible in one click.
6. Precision over recall. Hiding a real post costs more trust than missing an ad. When the model is unsure, don't hide.
7. Content script main-thread work stays under about 8 ms per mutation batch (measure with `performance.now()` in dev builds). Debounce mutation handling by 250 ms. Only send units to the model that are in or near the viewport.
8. All provider calls go through one interface and respect the daily budget.
9. TypeScript strict. No `any` in `src/` outside typed boundary shims.
10. `pnpm test` and `pnpm eval:mock` pass before a milestone is called done.
11. Design for service worker termination: no state that only lives in memory. Persist cache, budget counters and settings to storage.

## Conventions learned while building

- **Tests never touch live sites.** Fixtures in `fixtures/public/` are synthetic and
  carry `data-gold="sponsored|none"` on each unit root and `<meta name="sifter-host">`.
  Real captures go in `fixtures/private/` (gitignored) and never get committed.
- **Adapters are JSON** (`src/adapters/*.json`, validated by `schema.ts`). A broken
  site should be a one-line selector fix. Record how and when selectors were checked
  in the `verified` field.
- **Storage is locked to trusted contexts** (`setAccessLevel` in the service worker).
  Content scripts get settings and overrides only by message (`src/messages.ts`).
- **innerText is not a visibility check.** For an element that is itself
  `display:none`, it returns the full text. Label nodes go through `renderedWithin`.
- **Keep selectors simple.** happy-dom ignores complex `:not(a b)`, so a selector
  that works in Chrome can silently mis-judge in the evals. The scanner keeps
  innermost units only, so prefer that over exclusion selectors.
- **Fingerprints use the site key**, not the hostname, so aliases (twitter.com,
  google.nl, threads.net) share overrides. Opt-in hosts are the opposite: the real
  hostname, because they become match patterns.
- **The fixture gold includes suggested units.** The eval turns suggested on, so a
  `data-gold="suggested"` unit is a true positive, not noise.
- **CI runs more than `pnpm verify`**: build and e2e too. A green verify is not a
  green CI.
- **Give scanner tests a positive control.** A regression test whose units don't
  match the adapter's `unitSelector` passes without testing anything. Assert that
  the thing was hidden or queued first.
- **Writing code with backslashes:** use the Write/Edit tools. Bash heredocs and
  `node -e` strings mangle `\.`, `\n` and `\u0000` (this corrupted a regex and put
  a NUL byte into a .tsx file in session 3).
- Python is not used here. Node 24, pnpm 12.
