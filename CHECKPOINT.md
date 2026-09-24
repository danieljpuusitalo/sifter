# Sifter checkpoint

Updated 2026-09-24, session 2 (Google ad containers; scroll-cost rewrite of the scanner with a benchmark).

## Where it stands

M0 and M1 are built. The automated parts of both milestones pass. Three items still
need a human (listed below). Nothing is on GitHub yet: the repo has one local commit
and no remote, so CI has never run.

| Gate | State |
|---|---|
| `pnpm typecheck` | passes (tsc 7, strict; a negative control confirmed it catches errors) |
| `pnpm test` | 75/75, including `scanner-cost.test.ts` (a rescan examines only what changed) |
| `pnpm eval:mock` | 4 fixtures, tp=11 fp=0 fn=0 |
| `pnpm test:e2e` | 5/5 against the built extension: hide on all three sites, Show, Not an ad (persists across reload), popup render + page counts, infinite-scroll append |
| `pnpm bench:scroll` | 600-card feed, 4x CPU throttle, 20 s scroll, ext off vs on: the same forced layouts (40 vs 40), 0 slices over budget, 1 or 2 re-decisions. The old scanner examined about 22,000 units a run and blocked for up to 52 ms |
| `pnpm build` | `.output/sifter-0.0.1-chrome.zip`, 95 kB |
| `pnpm dev` opens Chrome with the popup | **not checked by an agent**: it opens a window on Daniel's screen |
| Infinite scroll still loads on the live sites | **manual, not done** |
| LinkedIn + Reddit live | Daniel confirmed that both hide ads (session 2) |
| Google Shopping + in-results ad blocks live | fixed against a synthetic fixture; **Daniel to re-check live** |

## Next

Daniel's direction (session 2): add Instagram, Facebook, X and Threads where that is
feasible, then at v1 do a FULL AUDIT (tests across the solution, systemic gap fixes).

1. Daniel: re-check Google (All and Shopping tabs) and scroll smoothness in `pnpm dev`.
2. New site adapters, one per session. Each needs its unit/label structure read from
   the live DOM (a real capture into `fixtures/private/`), then a synthetic public
   fixture and an e2e host. Expected difficulty: X and Threads use a plain-text
   "Ad" label (precision risk); Facebook obfuscates "Sponsored" into split spans,
   which is the hardest case; Instagram labels "Sponsored" under the author.
3. Open from session 1: the LinkedIn `labelNodeLimit` header check; VISION §8/§9
   decisions; whether to create the private GitHub repo so CI runs.

Known, not fixed: the "Not an ad" fingerprint includes live counters, so an override
can stop matching once a reaction count ticks. It belongs in the v1 audit.

The folder is still `~/sift`; the package, manifest and all identifiers say Sifter.

## Deviations from BRIEF.md (deliberate)

- The adapter schema has `hosts[]` rather than `host` (Google spans 19 country
  domains). It also adds `adSelectors` (structural markers), `labelNodeLimit` (label
  nodes past the header don't count) and a `verified` provenance note.
- The manifest adds `activeTab`, which shows no install warning; the popup uses it
  to read the current tab's hostname. The Google domains are enumerated because
  match patterns can't wildcard a TLD.
- Storage is set to `TRUSTED_CONTEXTS`. Content scripts get settings and overrides
  only by message, so rule 4 holds structurally, not just by convention.
- "Show" sticks per element for the page session. "Not an ad" persists per
  fingerprint.
- "gepromoot" was added to the marker words.

## Do not undo

- `renderedWithin` in `src/extract.ts`: innerText returns full text for an element
  that is itself `display:none`, so without this a hidden "Promoted" string hides an
  organic post. The eval caught this as a real false hide.
- `isAdClickUrl` matches `/aclk` only as a whole path segment on google.* hosts. A
  substring match flagged any site's `/aclk-guide`.
- The Google `unitSelector` avoids complex `:not()`, because happy-dom ignores it and the
  evals mis-judge. Ad-only containers (`adContainerSelector`) are hidden whole, so
  their "Sponsored" header goes with them. `[data-pla]` is deliberately not a marker.
- The scanner decides from MutationRecord dirt, not by re-walking the page, and runs
  in `requestIdleCallback` slices with reads before writes. Do not add `innerText` or
  `getComputedStyle` calls outside `decide()`: they force layout. Run `pnpm bench:scroll`
  after any scanner change.
