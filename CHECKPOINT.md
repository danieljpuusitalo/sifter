# Sifter checkpoint

Updated 2026-09-24, session 1 (M0 + M1, then renamed to Sifter and wrote docs/VISION.md).

## Where it stands

M0 and M1 are built. The automated parts of both milestones pass. Three items still
need a human (listed below). Nothing is on GitHub yet: the repo has one local commit
and no remote, so CI has never run.

| Gate | State |
|---|---|
| `pnpm typecheck` | passes (tsc 7, strict; a negative control confirmed it catches errors) |
| `pnpm test` | 70/70 |
| `pnpm eval:mock` | 3 fixtures, tp=8 fp=0 fn=0 |
| `pnpm test:e2e` | 5/5 against the built extension: hide on all three sites, Show, Not an ad (persists across reload), popup render + page counts, infinite-scroll append |
| `pnpm build` | `.output/sifter-0.0.1-chrome.zip`, 95 kB |
| `pnpm dev` opens Chrome with the popup | **not checked by an agent**: it opens a window on Daniel's screen |
| Infinite scroll still loads on the live sites | **manual, not done** |
| Reddit adapter vs the live DOM | **UNVERIFIED**: the browser tool is blocked on reddit.com |

## Next (for Daniel)

1. Run `pnpm dev`, open LinkedIn, Google and Reddit, scroll each feed for a minute,
   and confirm new content keeps loading and ads get placeholders. This is M1's last
   criterion.
2. On Reddit, confirm that `shreddit-post` and `shreddit-ad-post` still exist
   (DevTools → Elements). If they don't, fix `src/adapters/reddit.json`.
3. On LinkedIn, check how many `p[componentkey] > span` nodes sit above "Promoted" in
   a real ad header. `labelNodeLimit: 3` assumes three or fewer; a bigger header
   means ads get missed.
4. Read docs/VISION.md and approve, amend or reject its roadmap (§8) and decisions (§9) before M2. The store name "Sifter" is also taken by a highlighter extension; see §7.
5. Decide whether to create the GitHub repo (private) so CI runs.

Then the next milestone in a new session: M1.5 Perception if the VISION roadmap is approved, otherwise M2 as in the brief.

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
- The Google `unitSelector` avoids complex `:not()`: happy-dom ignores it and the
  evals mis-judge. Known gap: a `[data-dsktp-pla]` block placed inside `#rso` would
  leave its carousel shown. That is a miss, not a false hide.
