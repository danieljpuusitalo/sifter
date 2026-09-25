# Sifter checkpoint

Updated 2026-09-25, session 7: round two of live use (Facebook Stories band, X Show
revealing nothing, muted-words audit) plus a hardening pass, on
`fix/round-2-consistency` (PR #11; see "Session 7" below). Session 6 fixed the
first five complaints (PR #10). **Nothing is released for either round yet**: `main`
carries the fixes, `v1.0.0` is still the only tag, the CHANGELOG has an
`[Unreleased]` section.
Session 8 (same day, PR #12, on main as 31fd4e6) tagged Facebook **Experimental** in the
popup, the options page, README, CHANGELOG and store listing, after Daniel reported it
still leaky; one note in LAUNCH_SITES drives every surface, and a test pins the README row.
Session 9 (same day, PR #14, `fix/block-options-matrix`) answered "I turned off 'posts your
network liked' and it's still hiding them": live inspection showed the post also carried
a Follow button, so the `follow` rule held it, and the placeholder gave no clue. Now the
placeholder names the rule ("Hidden suggestion · People and pages you don't follow").
Every block option's on and off path is pinned on every site by a unit matrix
(`tests/unit/block-options-matrix.test.ts`, 38 cases: categories, each named rule as a
strict real subset, all rules off, site enable, muted word, element rule) and an e2e
matrix through the real popup messaging (`tests/e2e/block-options.spec.ts`, 8 cases).
The e2e run found a real bug on Threads: its `> div:first-child span` label selector
stopped matching once Sifter's placeholder became the unit's first child, so every
refresh released and re-hid the sponsored posts. `decide()` now detaches the placeholder
around its reads (`tests/unit/rescan-placeholder.test.ts`, failing before the fix).
Session 10 (same day, `fix/audit-hardening`) audited sessions 8 and 9 and then ran an
adversarial read-only audit over the whole tree. Fixed from the first pass: a read
that throws mid-rescan restores the placeholder and the hide (try/finally in
`decide()`, negative-controlled); `PageState.settled` plus polling in the e2e matrix,
because `sifter:refresh` answers with a 1 s snapshot on a slow machine (the one flake
seen, X 2 vs 3, was that); the matrix's suggested assertions no longer pass vacuously
on sites with no suggested gold; Playwright expect timeout 15 s / test 60 s. Fixed from
the adversarial pass, in the auditor's order: the store listing promised a note on
"every hidden post" while hide mode leaves none; ad-click URLs marked a unit on every
adapter although the comment said Google-only (now `!adapter || adapter.id ===
'google'`); `##*`, `##div`, `##body` were accepted as element rules (`tooBroad()` in
filters.ts, checked at save and again in the scanner); `setSiteEnabled` stored any
hostname and `doSync` unregistered the opt-in script before a registration that could
fail (now `HOSTNAME_RE` gate + `updateContentScripts` in place); the Sites table showed
an opt-in host "On" after Chrome revoked its grant. Deferred: rejecting `:has(` in
user rules (the shipped adapters use it; cost is bounded by the dirty-subtree path);
Reddit shadow-DOM DevTools check and Facebook "Suggested for you" live markup remain
Daniel's. Incident: the ops maintenance runner's disposable worktree (`sifter-probe`)
ran `pnpm install` and relinked this repo's `node_modules` to its own store, which then
vanished; `pnpm install --frozen-lockfile` repaired it. Under one busy-loop process the
e2e suite still passed 24/24.
Session 5 landed and tagged `v1.0.0` (`050e41f`); session 4 was the agent-driven
audit; session 3 shipped the seven adapters, popup, options and store docs.

## Where it stands

**2026-09-24, release hardening:** manifest now pins `minimum_chrome_version: '116'`
and drops `http://localhost/*` from `optional_host_permissions` until M2 exists.
Added `.github/workflows/pages.yml` (privacy policy on GitHub Pages) and
`.github/workflows/release.yml` (tag-triggered build + GitHub Release),
`CHANGELOG.md`, and a README install section. Path to the store is
`docs/ROADMAP.md`.

v1.0.0 is feature-complete for publication, apart from the live checks and the
store assets listed below. Seven sites: LinkedIn, Reddit, Google Search, X,
Instagram, Facebook and Threads. Three categories: sponsored (on by default),
suggested (off) and custom (muted words and element rules). Each has a global
toggle and per-site overrides. Within "suggested", each adapter names its kinds
of suggestion (`suggested.rules`: Facebook groups / follow / reels, Instagram
accounts / people, LinkedIn activity / follow / suggested). Each rule gets its own
per-site switch in the popup, shown under "Suggested posts" while that is on.
Settings store only the rules switched off (`sites[key].rules`).

| Gate | State |
|---|---|
| `pnpm typecheck` | passes |
| `pnpm test` | 203/203 (session 7 added 19: collapse min-height, foreign-hidden with positive control and hide-mode guard, `mutedWordRendered`, custom hints, `parseWords` errors, throwing-decide resilience, `noUnitsMatched`, adapter minimum-signal; session 6 added 15: inject match helpers, Facebook Stories, placeholder-in-unit show/rehide; session 5 added the shared-stylesheet test; session 4 added 15: settings caps and timestamps, `closed()` trailing backslash, adapter defaults parity, scanner change signature, trusted-click guard) |
| `pnpm eval:mock` | 8 fixtures, tp=61 fp=0 fn=0 (suggested pass included; both Google top-carousel shapes added 2026-09-24; with the pre-fix adapter the `#atvcap` shape is fn=1 and the eval FAILs, so the case discriminates) |
| `pnpm test:e2e` | 16 passed, 1 fixme (session 7 added the real-Chromium selector canary; session 6 added the Show/Hide reversibility test, which caught the double-inject race; session 5 added the placeholder constructed-sheet test; session 4 added the `setOverride` rejection test; it must send from an extension page, a service worker cannot message itself). One earlier run failed "muted words..." while a `pnpm dev` Chromium was also running (55 s vs a normal 24 s); not reproduced since. Watch it in CI |
| `pnpm bench:scroll` | **`--cpu 1 --strict`, 2026-09-25 session 7 at `8d57571` (foreign-hidden check, rendered muted-word confirmation, try/catch per unit)**: LinkedIn run 1 OK, Facebook run 1 OK. **Session 6 at `698dac1` (placeholder inside the unit, collapse via `UNIT_CSS`)**: LinkedIn run 1 OK, Facebook run 1 OK; 2 runs per site on the placeholder branch at `630d144` also all OK. **Session 5, `--cpu 1 --strict`, 2 runs per site, after the shared placeholder sheet**: all OK. LinkedIn p50/p95/p99 off vs on 16.7/17.5/24.9 vs 16.7/17.2/18.9 and 16.7/17.2/17.5 vs 16.7/17.2/19.4; Facebook 16.7/17.5/18.3 vs 16.7/16.9/18.4 and 16.7/17.1/19.0 vs 16.7/17.1/25.3. 0 long tasks in every run, 0 slices over budget, max scroll slice 3.2–8.6 ms, worst-slice apply phase 0–1.1 ms, `initialScanMs` 53–85 (that figure is the scanner's summed load-time work across idle slices, not one task: `longTasks` is 0, so the "75–81 ms long task at load" noted on 09-24 was this counter, not a main-thread stall). **Previous, 2026-09-24 late**: all OK. Frames p50/p95/p99 off vs on: LinkedIn 16.7/17.0/18.1 vs 16.7/17.2/19.1; Facebook 16.7/17.3/19.1 vs 16.7/17.3/19.2. 0 long tasks, 0 slices over budget, max scroll slice 5.5–11.4 ms, max single decide 1.1–1.9 ms, scanner total 45–65 ms per 15 s scroll. The 4x-throttle run is the frame A/B only: on this laptop's emulated x64 Chromium it shows random 10–17 ms spikes with the extension off too, so its slice counters are noise (verdict now scales with `--cpu`) |
| `pnpm build` | `.output/sifter-1.0.0-chrome.zip`, 92 kB (was 110 kB; content.js 40 kB, was 122 kB, after zod left the content script) |

## Live verification (from each adapter's `verified` field)

| Site | Sponsored | Suggested |
|---|---|---|
| LinkedIn | live DOM inspected 2026-09-24; Daniel confirmed | **live 2026-09-24**: social lines, Follow/Connect; "Suggested" word and NL/DE/FR UNVERIFIED |
| Reddit | Daniel confirmed it works (2026-09-24); markup not inspected by an agent | n/a |
| Google | markup inspected; Daniel: "does something", but the top **"Sponsored products" carousel stayed visible** for "shoes". Re-inspected the same evening: the live carousel (EN and NL) matches the adapter, both fixtures carry that layout and pass, Google does not undo the hide. Not reproducible from the code. Same evening, second report "still not working": dev build confirmed current (has the marker); the carousel is rendered from the streamed page before document_idle so the initial scan sees it; the late-injection path is covered by `tests/e2e/google-late.spec.ts` (2 pass, 1 fixme for attribute-only arrival, which Google does not do). **Sifter is loaded only in the two `pnpm dev` profiles on this machine, not in regular Chrome or Edge.** RESOLVED the same night: inspected Daniel's actual dev-Edge tab over CDP (port 9333, google.nl "shoes"): Google was serving a **second shape** of the carousel, `#atvcap` with `[data-pla=1]` and 29 `plap_` links and no `data-dsktp-pla` in the whole document, so no unit selector reached it. `#atvcap` added as unit, marker and container; the hot-reloaded dev build hid it on that tab (3 hidden: atvcap, tads, bottomads) and Daniel confirmed. Which shape you get is Google's A/B. Local pack / Maps: see below | n/a |
| X | Daniel confirmed promoted posts are hidden (2026-09-24), then doubted one. Agent tally the same evening: 41 tweets, structural marker and X's own "Ad" label agree on exactly 8, no disagreement, none of the 8 timestamped. Precision holds | UNVERIFIED |
| Instagram | live 2026-09-24 (ig_redirect, 6/6) | **live 2026-09-24**: Follow / "Suggested for you" articles, people module; NL/DE/FR UNVERIFIED |
| Facebook | rail live; feed: Daniel confirmed it works (2026-09-24) | **live 2026-09-24**: Follow, Join, Reels, group suggestions; NL/DE/FR UNVERIFIED |
| Threads | Daniel browsed it with Sifter on: no ads appeared, nothing organic hidden. Ad path still unverified | n/a |

Google, location searches (2026-09-24): "shoe store amsterdam" and "plumber amsterdam" served a Places pack
with no Sponsored or ad marker, so promoted places could not be inspected; "hotels amsterdam" hotel ads are
text ads inside the covered `[data-dsktp-pla=false]` wrapper. Google Maps (`google.com/maps`) is a separate app
with its own markup and is not covered; the tab used for inspection answered "can't find" to every Maps query,
so its promoted pins were not seen. Both stay open until a sponsored local result shows up live.

Per-rule switches, live 2026-09-24 on Facebook through the real popup. With every rule on: 4 Join posts hidden,
13 Follow posts hidden. After switching "Groups you're not in" off: 0 Join hidden, 2 shown, Follow still all
hidden. Switching it back on hid them again. Not yet clicked live on Instagram or LinkedIn (unit tests cover both).

These need a logged-in `pnpm dev` session. An agent can't provide one, since logging in means entering credentials.

## v1 audit (session 3): what was found and fixed

Each fix below has a regression test in `tests/unit/filters.test.ts` ("audit
regressions") or `settings.test.ts`. A mutation run confirmed the scanner tests
fail without their fixes.

- **Scanner**
  - Turning off a block category or an element rule left the module hidden. Block-hidden elements are now tracked and re-decided.
  - Switching a site off while slices were queued could still hide posts. The queue is now cleared, and `runSlice` checks `active`.
  - "Not an ad" or "Hide this post" left duplicates of the same post undecided. The whole page is now re-decided.
  - "Show" left the post in the popup counts.
  - Fingerprints used the hostname, so twitter.com and x.com overrides didn't match. They now use the site key.
  - Our own placeholder could be collected as a unit.
  - SVG `<style>` text leaked into the unit text.
  - New: `scanner.settled()`. The content script's `refresh` waits for it (capped at 1 s), so the popup reads finished counts.
- **Rules:** element rules for alias hosts (`twitter.com##`, `google.nl##`) never applied. A selector with an unclosed `(`, `[`, quote or `/*` swallowed every rule joined after it, so `closed()` now rejects those.
- **Settings:** one bad field reset the whole configuration; the schema now uses a per-field `.catch`. Opt-in hosts are now checked as plain hostnames, because they become match patterns. Words, rules and hosts are capped in size, and the options page refuses a backup over 5 MB.
- **Background**
  - Any sender could send any message. Content scripts are now limited to `getContext` and `setOverride`, with the hostname taken from `sender.url`.
  - Enabling old.reddit.com didn't work: it has an adapter, so it was treated as a launch host but never got a script. Launch is now decided by `isLaunchHost`.
  - Opt-in script sync calls could interleave; they are now serialised.
  - Settings changes (such as an import) and permission changes now trigger a resync.
  - The "Hide this post" menu now also covers opt-in sites.
  - The `setAccessLevel` and install setup promises now catch their errors.
- **Threads adapter:** an organic post that linked to the Meta Ad Library, or whose text started "Ads", was hidden. Labels now come from the header row only, and the ad marker is `facebook.com/ads/about`.
- **Popup and options**
  - A background `{error}` reply was reported as success; the shared `src/bg.ts` now throws it.
  - The popup requested permission for the aliased key instead of the real host.
  - Unhandled rejections are fixed.
  - An import didn't refresh the filter drafts. Stored changes now update them unless there are unsaved edits.
- **Content script:** after an extension update, the orphaned instance kept its hides and blocked the new one. A probe event now makes an orphan stand down, so the new instance takes over.

Not fixed, noted:
- happy-dom's `innerText` ignores `<br>` and block boundaries, unlike Chrome. Label tests use spans for this reason.
- The observer keeps running on a site that is switched off. It's cheap, because `scanNow` returns early.
- The popup e2e only renders the "unsupported" view. The running view's counts are covered through `getPageState`.

## v1 hardening audit (session 4, branch `audit/v1-hardening`)

Opus reviewed, Sonnet implemented the decided fixes, every receipt above was re-run
on the branch. What changed:

- **Scanner cost (hard rule 7).** Two real causes of slices over budget, both fixed:
  - the slice loop budgeted the next decide from the in-slice average, which underestimates a first full decide; it now carries an EMA of a fully decided unit's cost across slices (`decideCostMs`) and stops before a decide that would not fit.
  - Facebook's like/comment counters changed text on every unit every second, so every unit was re-decided (490/490 per scroll). The change signature (`changeSignature` in `src/fingerprint.ts`) now collapses digit runs; 30/490 re-decided since.
  - `renderedWithin` memoises ancestor visibility per decision (`VisibilityCache`), so a unit's label nodes pay for their shared ancestors once.
  - Zod left the content script: adapters are validated in the unit tests (`withDefaults` parity test) instead of parsed at every page load.
  - The bench records `maxDecideScroll` and `worstSlice` (phase breakdown of the longest slice), and fixed `maxSliceAtLoad`, which was read after the reset and always 0.
  - Tried and reverted: rAF-gating idle callbacks after writes. No effect on the spikes.
- **Background.** `sifter:setOverride` validates the fingerprint (`/^[0-9a-z]{1,16}$/`) and the action, and answers `{error:'invalid override'}`; the options page's global toggles, hide mode and filters now go through the background (`setCategory`, `setHideMode`, `setFilters`) instead of writing storage directly.
- **Settings.** Overrides are stored with a timestamp and capped (2000 per site, 10 000 total, oldest evicted); the old plain-string shape still parses. Each override entry is validated on its own, so one bad entry drops itself, not the site. The adapter schema is `.strict()`.
- **Content script.** "Show" / "Not an ad" buttons and the context-menu target require a trusted event (`isTrusted`), so page script cannot click them; the context-menu target expires after 1.5 s; `pageshow` from bfcache refreshes. Placeholders live in an open shadow root.
- **Rules.** `closed()` rejects a trailing backslash, which otherwise escapes the joining comma.
- **CI.** `ci.yml` has `permissions: contents: read`; `release.yml` checks out with `persist-credentials: false`; Playwright retries twice on CI.

Disclosures from the implementer run: it ran `taskkill` on stray `node.exe` processes once to unstick a hung Vitest (contention with a parallel run), and its new e2e test had not been executed when handed over; it failed on the first run (service worker messaging itself) and was rewritten to send from the popup page.

The shared constructed `CSSStyleSheet` for placeholders, listed here on 09-24 as
a follow-up, was done in session 5 (below).

## Session 5 (2026-09-25): landing v1.0.0

Daniel: "proceed, let's get this truly production ready." Done, with receipts:

- **Merged `audit/v1-hardening`** into `main` via PR #8 (merge commit `c87e1e1`), CI
  `verify` green on the branch head `547714c`.
- **Branch protection on `main`** (GitHub API, read back): required status check
  `verify` (strict), force-push blocked, deletion blocked, `enforce_admins` off so a
  direct checkpoint push by the owner still works. Everything else goes through a PR.
- **Decision, `document_start` CSS: no, not in v1.** A CSS hide before the script runs
  would have no placeholder and no one-click undo (hard rule 5), and every hide today
  is a scanner decision, not a selector. The first-visit flash is bounded by the first
  idle slice. BRIEF.md M4 (learned rules) is where `document_start` injection belongs,
  with its own verification loop.
- **Decision, `rel=sponsored`: stays global; ad-click URLs stay Google-only.** Reasoning
  is in the comment above the check in `src/extract.ts`. It is the publisher's own
  declaration that a link is paid, no launch site emits it on user posts, and on an
  opted-in generic site a unit built around a paid link is what the user asked to hide.
- **Shared placeholder stylesheet** (`src/content/hider.ts`): one constructed
  `CSSStyleSheet` per document, adopted by every placeholder's shadow root; falls back
  to a `<style>` element where constructable sheets are missing. Unit test asserts two
  placeholders share one sheet and carry no `<style>`; e2e asserts the row computes
  `display: flex` from the adopted sheet in real Chromium. Bench re-run at `--cpu 1
  --strict` (table above): OK on both sites, worst-slice apply 0–1.1 ms.
- **README GIF** (`docs/readme.gif`, 168 kB, 97 frames, 620x560): rendered by
  `pnpm readme:gif` from the LinkedIn fixture, without / with Sifter / a short scroll /
  "Show". The scroll stops above the fixture's trap units, which would read as misses.
- **Store assets** re-rendered from the current build: byte-identical to the committed
  PNGs, so the 09-24 note that they predate the per-rule switches was wrong or moot.
- README coverage table and CHANGELOG no longer describe the Google carousel as
  "under re-check"; it was resolved on 09-24 (`#atvcap` shape).
- **Session-5 branch merged** via PR #9 (merge commit `0de0c5b`), CI `verify` green
  on both branch commits (`469580b`, `4713194`).
- **`v1.0.0` tagged and released.** The first tag push (at `0de0c5b`) ran verify,
  build and e2e green on the tag, then failed in "Extract changelog section": the
  awk pattern `"^## [1.0.0]"` treated the brackets as a character class, so the
  literal heading could never match. Fixed in `release.yml` (`index($0, ver) == 1`),
  committed to `main` as `050e41f`, tested locally (32 lines for 1.0.0, 0 lines for a
  version with no section), tag moved to `050e41f` (no Release had been created, so
  nothing was replaced). Run 36107246645 green; GitHub Release `v1.0.0` exists with
  `sifter-1.0.0-chrome.zip` (92,090 bytes), not draft, not pre-release:
  `https://github.com/danieljpuusitalo/sifter/releases/tag/v1.0.0`. CI on `main` at
  `050e41f` green.

Still Daniel's, unchanged: the Web Store developer account and the submission itself
(ROADMAP Phase 4), a first run of the release zip in regular Chrome with a normal
profile, and the live recall checks (Threads ad, X suggested, NL/DE/FR words).

## Session 7 (2026-09-25): round two in Chrome, muted-words audit, hardening

Daniel confirmed Show/Hide and LinkedIn after PR #10, then reported: Facebook still
shows some "Suggested for you" posts (Follow posts are hidden), the Stories bar is
still visible, and X hides something that Show does not bring back. He also asked
for an audit of the muted-words feature and a hardening pass. Three implementer
agents on Sonnet did the changes in worktrees; merged on `fix/round-2-consistency`,
PR #11.

Root causes, verified live over CDP in his logged-in Chrome:

- **Facebook Stories**: the block rule matched and collapsed the region (classes and
  placeholder present), but the region has inline `min-height:160px`, so a 176 px
  empty band stayed. `UNIT_CSS` now zeroes min-height and resets height on a
  collapsed unit. Whether he saw cards or only the band was not confirmed.
- **X Show**: after a trusted Show click the unit is unhidden, but the
  `[data-testid="placementTracking"]` wrapper computes `display:none` from a rule in
  no CSSOM sheet that beats inline `!important`, and removing `data-testid` makes it
  render. That is another extension's cosmetic filter (an ad blocker) on his Chrome.
  Sifter now skips a unit whose marker element is unrendered by something else
  (`perf.foreignHidden`), guarded by `hider.isHidden` so hide mode's own inline
  `display:none` is never misread (that regression was caught by the test).
- **Facebook "Suggested for you" feed posts**: NOT fixed. The MCP tab is a background
  tab and Facebook does not paginate there (1 unit after trusted scrolls), so the
  post markup could not be captured. Hypothesis: a "Suggested for you" header span
  with no Follow/Join button, which no rule covers. Needs a foreground look.
- **Muted words audit**: hits matched hidden text (`unitText` walks every text
  node); the placeholder showed the post's first line instead of the reason;
  over-100-char words were saved then silently dropped by the schema; sub-2-char
  words were inert. All four fixed; `unitText` output unchanged (fingerprints).
- **Hardening**: try/catch per unit in `runSlice` (a throw used to leave `running`
  true and stop every future scan), guarded `textRootSelector`, adapter
  minimum-signal test with an allowlist (linkedin, reddit, google, x, instagram
  are single-signal), real-Chromium selector canary e2e, local `noUnitsMatched`
  popup line, CLAUDE.md convention on blocks vs suggested rules.

Not done: Facebook "Suggested for you" posts (needs markup), a release tag (Daniel
decides), the Facebook feed-ad path is still unverified live. Facebook is labelled
Experimental everywhere (session 8) until that path is fixed; drop the note in
`src/sites.ts` when it is, and the README test will demand the row change with it.

## Session 6 (2026-09-25): first real use in Chrome, audit and fixes

Daniel loaded `v1.0.0` unpacked into his own Chrome (`~/sifter-v1.0.0`, do not move
or delete) and reported: Facebook did nothing until he toggled the site in the popup;
Instagram hid "random posts" and the Show row looked inverted; LinkedIn posts
vanished and Show revealed a different post; Show could not be undone; scroll felt
buggy; and he wants Facebook Stories hideable. Each mechanism was audited live in
his logged-in Chrome over CDP (Claude-in-Chrome MCP tab), then fixed. Branch
`fix/chrome-consistency`, PR #10, CI green at `698dac1` (verify + build + e2e).

**Root causes, one per complaint:**

- **Facebook "not running until toggled": Chrome never injects `content_scripts`
  into tabs already open at install.** Toggling the site in the popup ran the
  popup's `executeScript`, which is why it "started working". Fix: `onInstalled`
  now injects `content-scripts/content.js` into every open launch-site (and granted
  opt-in) tab (`injectIntoOpenTabs` in `background.ts`; pure helpers
  `optInScriptMatches` / `injectTargetMatches` in `src/sites.ts`, unit-tested).
  This exposed a second race: install-time injection and the `content_scripts`
  entry can start in the same tick, and the probe listener was only registered
  after the settings await, so both instances ran and every unit got two
  placeholders (caught by the new Show/Hide e2e). `content.ts` now registers the
  probe listener before its first await.
- **LinkedIn "blocked post vanishes, Show shows something else": the new feed is
  virtualised.** A `display:none` unit measures 0 px, and LinkedIn parks the whole
  slot off-screen (`height: 0px; left: -10000px; position: absolute`), taking the
  sibling placeholder with it. The next post slides up, so Show appeared to reveal
  the wrong thing. Fix: the placeholder is now the unit's **first child**, so it
  moves with the post; collapse and blur hide the unit's own children through a
  shared stylesheet (`.sifter-collapse > :not([data-sifter-placeholder])`) rather
  than the unit itself. Only `hide` mode still touches inline style.
- **Instagram "random posts hidden / inverted": precision held.** Every hidden unit
  in the audit carried "Suggested for you", a Follow button, or an ad link; the two
  suggested posts still visible were hidden once the throttled tab scanned them.
  What Daniel saw was the same placeholder-position illusion as LinkedIn: a sibling
  row above the unit reads as a divider over the *next* post. The card placeholder
  inside the unit, naming what it hid ("Hidden sponsored post · <author>"), removes
  the ambiguity.
- **"Can't unshow": by design in v1, now changed.** Show kept the content and dropped
  the placeholder. Now Show leaves a "Showing hidden sponsored post" bar with a
  Hide button (`hider.show` / `hider.rehide`; `scanner.userRehide` restores the
  fingerprint). "Not an ad" is still the hard reset.
- **Facebook Stories:** new suggested rule `stories` (block on the
  `[role=main] div[role=region]:has(a[href*="/stories/create"])` module). It sits
  under the **suggested category, which is off by default**, so Daniel must switch
  the category on for the switch to appear. Fixture, unit test and suggest-rules
  test added.
- **Scroll "buggy":** no defect found. Bench `--cpu 1 --strict` OK on both sites
  (table above). The live A/B could not be judged honestly: the MCP audit tab is a
  background tab (`visibilityState: hidden`), where Facebook pauses pagination and
  Chrome throttles timers, rAF and ResizeObserver, so every latency measured there
  is inflated. Daniel should judge smoothness in his own foreground tab, site
  toggled off vs on.

**Receipts:** `pnpm verify` 10 files, 184 tests, eval tp=61 fp=0 fn=0 PASS;
`pnpm test:e2e` 15 passed, 1 skipped (new: "Show reveals the unit for this page
only, and Hide puts it back"); CI run 36149551558 all steps green; bench line in
the gate table. Not done: a `v1.0.1` tag (Daniel decides), and the Facebook feed-ad
path is still unverified live (no sponsored feed post appeared this session either).

## Next

0. **Production-readiness verdict (2026-09-24, end of session): ready for an UNLISTED v1.0.0 submission, not yet for a promoted Public listing.** Phase 3 is done (release.yml on `v*` tags, CHANGELOG, privacy page live on Pages and linked from `docs/STORE_LISTING.md`, `homepage_url` + `minimum_chrome_version` in the manifest, repo public, main `aaccdde` green incl. build + e2e). Precision evidence is strong (fp=0 on every fixture; X tally 8/8). Unproven, all recall-side: Threads ad path (no ad has appeared yet), X suggested units, NL/DE/FR marker words (baseline guesses), Google carousel shapes rotate by A/B (a third shape = patch tag), the release build has never run in regular Chrome with a normal profile, and one 75–81 ms long task at load (2026-09-25: that figure was the summed `initialScanMs` counter, not a long task; `longTasks=0`). **Tagged and released 2026-09-25** (`v1.0.0` at `050e41f`). Next action is ROADMAP Phase 4, all Daniel's: download `sifter-1.0.0-chrome.zip` from the GitHub Release, submit Unlisted, install it into regular Chrome and use it for a few days, flip to Public once Threads shows an ad hidden.
1. **Daniel:** live results are in the table above (2026-09-24). The Google carousel miss is fixed (`#atvcap` shape). Still open: the suggested words on each site; a sponsored local result or Maps pin when one appears. `v1.0.0` is tagged; the submission is ROADMAP Phase 4.
   - Scroll smoothness, 2026-09-24:
     - Most of the lag was the dev browser: x64 Chromium emulated on ARM64.
     - Sifter's only measured cost was a 12–13 ms forced layout from `innerText`, now removed.
     - Reddit A/B in native Edge: long frames 13/10 with Sifter on vs 26/12 off, 0 slow slices.
   - Logged-in Edge A/B, 20 s wheel scroll, two runs each way:

     | Site | Sifter on | Sifter off |
     |---|---|---|
     | LinkedIn | 0 frames >50 ms, 0 layout shifts | same |
     | Facebook, quiet run | 0 frames >50 ms, 0 layout shifts | 0 and 59 frames |
     | Facebook, heavy run | 42 and 34 frames >50 ms | 38 and 43 |

     Facebook's own load varies; Sifter adds nothing measurable. 0 slow slices anywhere.
   - Facebook (live 2026-09-24):
     - The right-rail "Sponsored" module is hidden: the smallest div holding the h3 and the `a[aria-label=Advertiser]` cards. It is a block with `innermost`, because its `:has()` rule also matches every ancestor up to the whole rail.
     - The "Suggested for you" groups carousel is a suggested marker.
     - **No sponsored feed post appeared in 51 posts, so feed-ad detection on Facebook is still unverified live.** Re-check when one shows up.
   - **"Only my network", 2026-09-24, in the suggested category** (off by default; the dev profile has per-site overrides ON for facebook, instagram and linkedin):
     - Facebook: posts with a Follow or Join button in the author header, the Reels unit (h3 "Reels"), "Your group suggestions" (aria-label "Join group"). Live: 20 Follow + 6 Join + 2 module units hidden, 21 shown, none of the shown with either button.
     - Instagram: articles with a Follow button or "Suggested for you" (articles no longer have a `<header>`), and the people carousel as an innermost block. Live: 0 visible "Suggested for you".
     - LinkedIn: "<Name> likes/celebrates/loves/... this" (new `suggested.lineEndings`, checked on the card's top line only) and Follow/Connect in the 5-node header. Reposts are kept, including a connection's reshare of a stranger's post. Live: every hidden unit carried a signal; the 2 shown units with a Follow button were both reshares.
     - Suggested labels over 300 chars are treated as post body and skipped.
     - NL/DE/FR strings are baseline guesses; Daniel's UI is English, so only English is checked.
   - **Per-rule switches** (commit 46434ef): live-checked only for Facebook "Groups you're not in". Still to click live: the Reels switch (no Reels unit appeared that session), and the Instagram and LinkedIn switches. `scratchpad`-style CDP check: open popup.html in its own window with `chrome.tabs.query` patched to return the site tab, click `label.sub`, count units by header button.
   - **Store screenshots are current**: `pnpm store:assets` on 2026-09-25 rendered byte-identical PNGs to the committed ones.
   - **Daniel's calls after the session-4 audit**: all closed in session 5 (merge, branch protection, `document_start` = no for v1, `rel=sponsored` = global, README GIF, tag `v1.0.0`).
2. **Licence:** MIT (`LICENSE`), done.
3. **Privacy policy URL** is live: `https://danieljpuusitalo.github.io/sifter/privacy/` (repo made public 2026-09-24, Pages deploys from `pages.yml`). Submission steps are in `docs/ROADMAP.md` Phase 4; they are Daniel's.
4. M2 (tier-1 model classification, BRIEF.md §9) has not started. `http://localhost/*` was removed from `optional_host_permissions` on 2026-09-24 (an unused permission is a review question); M2 re-adds it for its local providers.

## Deviations from BRIEF.md (deliberate)

- **Adapter schema:**
  - `hosts[]` rather than `host`, because Google spans 19 country domains
  - adds `adSelectors`, `labelNodeLimit`, `adContainerSelector`, `blocks`, `suggested`, and a `verified` provenance note
- **Manifest:** adds `activeTab` and `contextMenus`. Google domains are enumerated, because match patterns can't wildcard a TLD.
- **Storage:** set to `TRUSTED_CONTEXTS`, and the background authorises each message by sender.
- **Overrides:** "Show" sticks per element for the page session. "Not an ad" persists per fingerprint.
- **Categories and filters:** the categories, muted words and element rules (`site##selector`) are an ad-blocker-style layer on top of the brief.

## Do not undo

- **`renderedWithin` in `src/extract.ts`:** innerText returns the full text of an element that is itself `display:none`.
- **`renderedText`, not innerText, for labels:** innerText forces whole-page layout mid-scroll.
- **`isAdClickUrl`:** matches `/aclk` only as a whole path segment on google.* hosts.
- **The Google `unitSelector`:** avoids complex `:not()`, which happy-dom ignores.
- **Scanner slicing:**
  - the scanner decides from MutationRecord dirt and runs in idle slices, reads before writes
  - no `innerText` or `getComputedStyle` outside `decide()`
  - run `pnpm bench:scroll` after any scanner change
- **`closed()` in `src/rules/filters.ts`:** Chrome auto-closes an unfinished selector on its own, but inside the joined block selector it swallows its neighbours.
- **Suggested rule ids** (`suggested.rules[].id`) are storage keys: renaming one silently resets every user's switch for it.
- **Background `authorize()`:** a content script's hostname comes from `sender.url`, never from the message.
- **Placeholder CSS through one adopted sheet** (`placeholderSheet` in `src/content/hider.ts`): a `<style>` per placeholder re-parses the same CSS on every hide. Keep the `<style>` fallback for realms without constructable sheets.
- **`rel=sponsored` is global; ad-click URLs count only on Google and on opted-in generic sites** (`adLinks` gate in `detectMarker`, session 10). Decided 2026-09-25; the reasoning sits above the check in `src/extract.ts`.
- **`tooBroad()` runs twice**, at save (`parseRules`) and in `compileContext`: storage is data, and an imported backup skips the options page.
- **`doSync` updates the opt-in registration in place** (`updateContentScripts`), and unregisters only when the match list is empty. Unregister-then-register left every opt-in site dark when the register step was refused.
- **The placeholder is the unit's first child, not a sibling** (session 6): LinkedIn's virtualised feed parks a 0-height slot off-screen with its siblings. Collapse and blur go through `UNIT_CSS` on the unit's children; only `hide` mode writes inline style to the unit.
- **`content.ts` registers the probe listener before its first `await`:** install-time `executeScript` and `content_scripts` can start in the same tick, and a late listener lets both instances run.
- **Foreign-hidden check is gated on `hider.isHidden(unit)` first** (session 7): the unmask window lifts classes only; hide mode's inline `display:none` stays, and without the gate a rescan unhides Sifter's own hides.
- **`decide()` and `apply()` run through `decideSafely`/`applySafely`**: a throw inside one unit must not leave `running` true with no scan scheduled.
- **`release.yml` matches the CHANGELOG heading with `index()`, not a regex.** `## [x.y.z]` as an awk regex is a character class and never matches; this failed the first `v1.0.0` run after every test had passed.
