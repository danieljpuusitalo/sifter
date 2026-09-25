# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Facebook: a "Stories bar at the top" suggested rule, hiding the Stories
  module on the home feed (off by default, like every suggested rule).

### Fixed

- LinkedIn hidden posts vanished with their Show row: the virtualised feed
  measures a `display:none` unit at 0px and parks the whole slot off-screen,
  taking a sibling placeholder with it. The placeholder now lives inside the
  unit as its first child, so it moves and resizes with the post instead of
  disappearing. Collapse and blur modes hide the unit's own content through a
  shared stylesheet rather than the unit itself, and the placeholder names
  what it hid (e.g. "Hidden sponsored post · Remedy Entertainment").
- Show is reversible: a shown post keeps its "Showing hidden sponsored post"
  bar with a Hide button, instead of losing the placeholder until reload.
- The content script is now force-injected into launch-site (and granted
  opt-in) tabs that were already open at install or update. Chrome never runs
  `content_scripts` against pre-existing tabs, so Sifter previously did
  nothing on an open tab until the popup was used to toggle the site.
- The content script's initial settings load now retries (300 ms, 900 ms
  backoff) if the service worker is asleep or mid-update, falling back to
  `defaultContext` and logging a warning instead of never starting the
  scanner.
- Facebook's Stories bar left a 160px blank box behind: the block rule hid its
  children, but an inline `min-height` on the unit itself kept the empty slot.
  A collapsed unit now also drops its own min/max/height back to auto.
- A unit already hidden by something other than Sifter (another extension's
  cosmetic filter beating an inline `!important`, invisible to the page CSSOM)
  no longer gets a Sifter placeholder that Show can't reveal: Sifter now skips
  it instead of stacking a hide on top of one.

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
  Instagram (sponsored + suggested), Reddit, X, Facebook (feed and right rail,
  plus suggested), Google Search text ads.
- Google: both known shapes of the top "Sponsored products" carousel are
  covered (verified live, EN and NL). Google serves markup by experiment, so a
  new shape can appear; it is a one-line adapter fix. Promoted places in the
  local pack were never served during inspection, so they are unverified, and
  Google Maps is not covered.
- Threads: runs without hiding organic posts; no ad has appeared live yet to
  confirm the ad path.
- Dutch, German and French marker strings on Facebook, Instagram and LinkedIn
  are baseline guesses, not checked against a live non-English UI. A wrong
  guess misses an ad rather than hiding a real post.
