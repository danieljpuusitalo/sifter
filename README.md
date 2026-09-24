# Sifter

A Chrome extension that hides the ads your ad blocker misses: the sponsored posts and
promoted results that sites serve from their own servers, inside the feed, where
network-level blockers can't reach them.

Sifter reads the label the site already shows ("Sponsored", "Promoted", "Ad") and
hides that post. It runs entirely in your browser. No account, no server, no AI.

## What it covers

| Site | Sponsored posts | Suggested posts | Checked against the live site |
|---|---|---|---|
| LinkedIn | yes | yes | sponsored: yes · suggested: not yet |
| Reddit | yes | – | confirmed working in use; markup not inspected |
| Google Search | yes (text ads, shopping units) | – | markup inspected; re-check in use pending |
| X | yes | "Who to follow" | yes |
| Instagram | yes | yes | sponsored: yes · suggested: not yet |
| Facebook | yes | yes | not yet |
| Threads | yes | – | not yet |

"Not yet" means the rules come from known markup and pass the synthetic fixtures, but
nobody has watched them work on a logged-in feed. Every adapter's `verified` field
records exactly what was checked and when.

Any other site can be turned on from the popup ("Hide ads on this site"). There,
Sifter uses general detection: it hides elements whose whole visible label is
"Sponsored", "Ad" or similar.

## What you control

- **What to block**, like an ad blocker's filter lists: sponsored posts (on by
  default), suggested posts (off by default, since they aren't ads) and your own filters.
  Set these globally, then override them per site in the popup or on the settings page.
- **Muted words.** Hide any post containing a word or phrase.
- **Element rules** in the ad-blocker form `site##selector`.
- **Hide this post**, from the right-click menu, for anything Sifter missed.
- **Not an ad / Always show** on any hidden post. Sifter remembers these.
- **How hidden posts look:** collapsed to a one-line note, blurred, or removed from
  view entirely. Sifter never deletes anything from the page; every hide can be undone.
- Pause for an hour, turn any site off, and back up or restore all of it as one file.

## Privacy

Everything happens on your device. See [PRIVACY.md](PRIVACY.md).

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm exec playwright install chromium   # first time only
pnpm dev          # Chromium with the extension loaded, hot reload
pnpm verify       # typecheck + unit tests + fixture eval (what CI runs)
pnpm test:e2e     # the built extension against local fixtures
pnpm build        # .output/chrome-mv3 and a store zip
```

Tests never touch a live site. Each site's detection lives in a JSON adapter
(`src/adapters/*.json`), checked against a synthetic fixture in `fixtures/public/`
that marks every post with the right answer (`data-gold`). `pnpm eval:mock` fails on
any wrongly hidden post or missed ad. When a site changes its markup, the fix is
usually one selector in its adapter, plus a fixture case that shows the change.

`CLAUDE.md` has the working rules, `BRIEF.md` the original spec, `CHECKPOINT.md` the
current state and `docs/VISION.md` the longer-term architecture.
