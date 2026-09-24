# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-09-24

### Added

- Seven site adapters: LinkedIn, Reddit, Google Search, X, Instagram, Facebook
  and Threads.
- Three filter categories, each with a global toggle and per-site overrides:
  sponsored posts (on by default), suggested posts from accounts you don't
  follow (off by default, with a per-rule switch for each adapter's kinds of
  suggestion), and custom rules (muted words, element rules in `site##selector`
  form).
- "Show" and "Not an ad" on any hidden post; a right-click context menu entry,
  "Hide this post", for anything missed.
- Opt-in: turn Sifter on for any other site from the popup, using general
  "Sponsored"/"Ad" label detection.
- Settings export/import as a single backup file.

### Known limitations

- Live-verified against a logged-in feed: LinkedIn (sponsored + suggested),
  Instagram (sponsored + suggested), Google Search (sponsored), X (sponsored).
- Not yet verified live: Reddit (works in manual use; markup not inspected
  against the adapter), Facebook feed ads (only the right rail is verified live; feed
  suggested rules are verified live), Threads (fully unverified, no logged-in
  session available).
- Dutch, German and French marker strings on Facebook, Instagram and LinkedIn
  are baseline guesses, not checked against a live non-English UI. A wrong
  guess misses an ad rather than hiding a real post.
