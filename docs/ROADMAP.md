# Sifter: road to the Chrome Web Store

Written 2026-09-24 from a repo audit (manifest, assets, privacy, CI, adapters) plus
the Web Store submission process. Scope is **v1.0.0, labels-only**. M2 (model tier)
is not on this path and must not block it.

Legend: **[D]** only Daniel can do it (login, money, identity, decision).
**[A]** an agent can do it in the repo with `pnpm verify` + CI as the oracle.

## Where the repo already is

Done and in `main`: MV3 manifest, icons at 16/32/48/128, `LICENSE` (MIT),
`PRIVACY.md`, `docs/STORE_LISTING.md` (title, 114-char summary, description,
single-purpose statement, permission justifications), three 1280x800 screenshots
and the 440x280 promo tile in `docs/store/`, CI green (typecheck, test, eval:mock,
build, e2e). No `eval`, `innerHTML` or `fetch` anywhere in `src/`, so the
"no remote code" policy is satisfied by construction.

## Phase 1: decisions (Daniel, before anything else) [D]

1. **Name and store title.** "Sifter" and "Sift" both exist on the store
   (`docs/VISION.md` §7). Store names are not unique, so this is not a blocker,
   but it affects search. Options: keep `Sifter: hide sponsored posts`, or a more
   distinctive title. Decide once; renaming later resets store search history.
2. **Where the privacy policy lives.** The store needs a live URL, and
   `PRIVACY.md` is a repo file. Two options:
   - **danieluusitalo.com/sifter/privacy** (recommended: works while the repo is
     still private, one page in the existing site repo).
   - GitHub Pages on this repo, which requires making the repo public first.
3. **Public repo timing.** "Open source on GitHub" is a v0.1 goal. Going public
   before submission lets the listing link to the source. Nothing in the tree is
   secret (`fixtures/private/` is gitignored; confirm with `git ls-files`).
4. **Distribution.** Recommend **Unlisted** for the first submission: it gets
   through review and gives a real install link for testing, and can be flipped
   to Public later without resubmitting.

## Phase 2: live verification (Daniel, logged-in `pnpm dev` in Edge) [D]

Each row is an adapter `verified` field that still says UNVERIFIED. An agent
cannot do these because they need a logged-in session.

| Site | What to check | Pass condition |
|---|---|---|
| Reddit | home, a subreddit, search | promoted posts hidden, no organic post hidden, infinite scroll still loads |
| Threads | home feed | sponsored posts hidden (marker `facebook.com/ads/about`), organic kept |
| Facebook | feed | at least one **feed** ad hidden (only the right rail is verified) |
| X | home timeline | "Who to follow" / suggested units hidden with suggested ON |
| Google | All + Shopping | ads hidden, organic and shopping-organic kept |
| Instagram, LinkedIn | popup per-rule switches | each rule switch shows and re-hides its units |

Record each result in the adapter's `verified` field and the checkpoint table.
For each adapter with a real defect, hand the selector fix to an agent [A].

**NL/DE/FR marker strings:** ship them as baseline guesses. A wrong guess misses
an ad (recall) rather than hiding a post (precision), which rule 6 accepts. Note
it in the README coverage table rather than blocking on it.

## Phase 3: release hardening (agent work, one PR) [A]

1. **Manifest:** add `homepage_url` (repo or site page); add
   `minimum_chrome_version` matching what e2e runs against. **Remove
   `http://localhost/*` from `optional_host_permissions` until M2 exists**: an
   unused permission is a review question with no answer.
2. **Privacy policy page:** publish `PRIVACY.md` at the URL decided in Phase 1
   and put the URL in `docs/STORE_LISTING.md`.
3. **Release workflow:** on a `v*` tag, run the full CI job, upload
   `.output/sifter-<version>-chrome.zip` as a workflow artifact and attach it to
   a GitHub Release. This makes "the zip that was submitted" reproducible.
4. **`CHANGELOG.md`** with a 1.0.0 entry (sites, categories, what is unverified).
5. **README:** add the store screenshots and an end-user install section
   (store link once live, "load unpacked" until then). Keep the coverage table
   honest: verified vs baseline-guess per site and language.
6. **Store assets:** re-run `pnpm store:assets` after Phase 2, because the
   current popup screenshot predates the per-rule switches. Optionally add the
   1400x560 marquee tile (not required).
7. **Apply the Phase 1 title** to `docs/STORE_LISTING.md` and `wxt.config.ts` if
   it changed.

Gate: `pnpm verify` green, CI green on the PR, `pnpm bench:scroll` unchanged if
any scanner file was touched (none should be).

## Phase 4: submission (Daniel) [D]

1. Chrome Web Store developer account: sign in, pay the $5 one-off fee, enable
   2-Step Verification on the Google account.
2. Tag `v1.0.0`, take the zip from the GitHub Release (Phase 3.3).
3. Developer Dashboard: **Add new item**, upload the zip.
4. **Store listing tab:** paste title, summary and description from
   `docs/STORE_LISTING.md`; category Productivity; upload the three screenshots
   and the promo tile; icon comes from the manifest.
5. **Privacy tab:** single-purpose statement and one justification per
   permission (`storage`, `scripting`, `activeTab`, `contextMenus`, optional
   `https://*/*`) from `docs/STORE_LISTING.md`; data-use disclosures ("website
   content", processed locally, not sold, not used for other purposes); privacy
   policy URL from Phase 3.2. Declare "does not use remote code".
6. **Distribution tab:** Unlisted (Phase 1.4), all regions.
7. **Submit for review.** Typical wait is a few days. Broad optional host
   permissions are the likeliest reviewer question; the justification already
   explains they are requested only when the user opts a site in.
8. **Edge Add-ons:** same zip, free account, submit after Chrome approves so
   any review feedback is applied once.

## Phase 5: after approval [D] then [A]

- Flip to Public when satisfied with the unlisted install.
- Public repo if not already; launch channels per `BRIEF.md` §10.
- Set the adapter-breakage loop: a site change is a one-line JSON fix plus an
  e2e fixture update, released as a patch tag through Phase 3.3.
- Only then: M2 (model tier), which re-adds `http://localhost/*` and brings
  provider key handling into `PRIVACY.md`.

## Critical path

Phase 1 decisions (an hour) → Phase 2 live checks (one evening) → Phase 3 PR
(one agent session, can start in parallel once Phase 1.2 is decided) → Phase 4
submission (an hour) → review wait (days).
