# Sifter checkpoint

Updated 2026-09-25, session 5: release landing. The session-4 audit branch is
merged (PR #8, `c87e1e1`), `main` is protected, the two open decisions are made,
the placeholder stylesheet follow-up is done, the README has its GIF, and the
`v1.0.0` tag is the next step (see "Session 5" below for receipts). Session 4 was
the second, agent-driven audit (security, scanner cost, settings, CI). Session 3
shipped the seven adapters, popup and options page, icons and store docs.

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
| `pnpm test` | 169/169 (session 5 added the shared-stylesheet test; session 4 added 15: settings caps and timestamps, `closed()` trailing backslash, adapter defaults parity, scanner change signature, trusted-click guard) |
| `pnpm eval:mock` | 8 fixtures, tp=60 fp=0 fn=0 (suggested pass included; both Google top-carousel shapes added 2026-09-24; with the pre-fix adapter the `#atvcap` shape is fn=1 and the eval FAILs, so the case discriminates) |
| `pnpm test:e2e` | 15 passed, 1 fixme (session 5 added the placeholder constructed-sheet test; session 4 added the `setOverride` rejection test; it must send from an extension page, a service worker cannot message itself). One earlier run failed "muted words..." while a `pnpm dev` Chromium was also running (55 s vs a normal 24 s); not reproduced since. Watch it in CI |
| `pnpm bench:scroll` | **`--cpu 1 --strict`, 2 runs per site, 2026-09-25 after the shared placeholder sheet**: all OK. LinkedIn p50/p95/p99 off vs on 16.7/17.5/24.9 vs 16.7/17.2/18.9 and 16.7/17.2/17.5 vs 16.7/17.2/19.4; Facebook 16.7/17.5/18.3 vs 16.7/16.9/18.4 and 16.7/17.1/19.0 vs 16.7/17.1/25.3. 0 long tasks in every run, 0 slices over budget, max scroll slice 3.2–8.6 ms, worst-slice apply phase 0–1.1 ms, `initialScanMs` 53–85 (that figure is the scanner's summed load-time work across idle slices, not one task: `longTasks` is 0, so the "75–81 ms long task at load" noted on 09-24 was this counter, not a main-thread stall). **Previous, 2026-09-24 late**: all OK. Frames p50/p95/p99 off vs on: LinkedIn 16.7/17.0/18.1 vs 16.7/17.2/19.1; Facebook 16.7/17.3/19.1 vs 16.7/17.3/19.2. 0 long tasks, 0 slices over budget, max scroll slice 5.5–11.4 ms, max single decide 1.1–1.9 ms, scanner total 45–65 ms per 15 s scroll. The 4x-throttle run is the frame A/B only: on this laptop's emulated x64 Chromium it shows random 10–17 ms spikes with the extension off too, so its slice counters are noise (verdict now scales with `--cpu`) |
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

Not done, a possible follow-up with no receipt yet: a shared constructed `CSSStyleSheet` (`adoptedStyleSheets`) for the placeholders. One LinkedIn apply phase measured 7.9 ms at real speed; a shared sheet would avoid a style element per placeholder.

## Next

0. **Production-readiness verdict (2026-09-24, end of session): ready for an UNLISTED v1.0.0 submission, not yet for a promoted Public listing.** Phase 3 is done (release.yml on `v*` tags, CHANGELOG, privacy page live on Pages and linked from `docs/STORE_LISTING.md`, `homepage_url` + `minimum_chrome_version` in the manifest, repo public, main `aaccdde` green incl. build + e2e). Precision evidence is strong (fp=0 on every fixture; X tally 8/8). Unproven, all recall-side: Threads ad path (no ad has appeared yet), X suggested units, NL/DE/FR marker words (baseline guesses), Google carousel shapes rotate by A/B (a third shape = patch tag), the release build has never run in regular Chrome with a normal profile, and one 75–81 ms long task at load. **No git tag exists yet.** Next action is ROADMAP Phase 4 step 2: tag `v1.0.0`, take the zip from the GitHub Release, submit Unlisted, install it into regular Chrome and use it for a few days, flip to Public once Threads shows an ad hidden.
1. **Daniel:** live results are in the table above (2026-09-24). The Google carousel miss is fixed (`#atvcap` shape). Still open: the suggested words on each site; a sponsored local result or Maps pin when one appears. Then tag v1.0.0 and submit (ROADMAP Phase 4).
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
   - **Store screenshots predate the per-rule switches and the live count.** Re-run `pnpm store:assets` before submitting if the popup shot should show them.
   - **Daniel's calls after the session-4 audit**: all closed in session 5 (merge, branch protection, `document_start` = no for v1, `rel=sponsored` = global, README GIF). Tag `v1.0.0` follows once the session-5 PR is merged.
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
- **`rel=sponsored` is global, `/aclk` is Google-only.** Decided 2026-09-25; the reasoning sits above the check in `src/extract.ts`.
