# Chrome Web Store listing: draft

## Name
Sifter: hide sponsored posts

The dashboard takes the item title from the manifest `name`, which is "Sifter"; it
has no separate title field. The longer name above is for the README and anywhere
else that asks for one. For an Unlisted listing this does not matter.

## Summary (132 characters max)
Hides the sponsored posts your ad blocker misses: the ones a site places in your feed or search results itself.

This is also the manifest `description` (`wxt.config.ts`), which the store shows as
the summary. Keep the two identical.

**Name no sites here.** v1.3.0 was rejected on 2026-10-18 for "Keyword spam" (reference
Yellow Argon), quoting the old summary's list of seven site names as "excessive and/or
irrelevant keywords". The sites belong in the description, in a sentence that says
what Sifter does on each.

## Category
Social Networking (under Lifestyle). Alternative: Functionality & UI. The old
"Productivity" and "Social & Communication" are no longer top-level choices in the
2024 category list. Confirm against the dashboard's dropdown when submitting.

## Language
English

## Description

Ad blockers stop ads served by ad networks. They can't stop the ones a site serves
itself, as posts in your feed. Those carry the site's own label ("Sponsored",
"Promoted", "Ad"), and that label is what Sifter reads.

WHAT IT HIDES
• Sponsored posts on LinkedIn, Reddit, X and Instagram, plus Facebook (experimental: partial coverage) and Threads (experimental: no ad seen live yet)
• Sponsored results and shopping ads on Google Search results pages (not Google Hotels, Flights or Maps)
• Optionally, suggested posts from accounts you don't follow (in your home feed only; profiles and pages you open are left alone)
• Anything matching your own muted words or element rules

YOU'RE IN CONTROL
• Choose what to block, globally or per site, like an ad blocker's filter lists
• Collapse (the default) or blur a hidden post: a one-line note stays, to open it or mark it "Not an ad". Or hide completely, with no note
• Missed one? Right-click it and choose "Hide this post with Sifter"
• Pause for an hour, or turn any site off
• Turn it on for other sites from the popup

PRIVATE BY DESIGN
• Runs entirely in your browser: no account, no server, no analytics
• Makes no network requests of its own
• Keeps your settings and exceptions on your device. On LinkedIn, with Suggested on, that includes your own profile link, so posts that mention you are never hidden
• Never removes anything from the page, so feeds and infinite scroll keep working

## Single purpose (for review)
Declutter the user's feeds by hiding posts they did not ask to see: posts the site itself labels as sponsored or promoted, optionally posts it labels as suggested, and posts matching the user's own filters, on the sites the user chooses.

## Permission justifications (for review)
- Host permissions (LinkedIn, Reddit, X/Twitter, Instagram, Facebook, Threads, Google Search and its country domains): read the page in the browser to find posts the site labels as sponsored, and hide them. Nothing is transmitted.
- Optional host permissions (https://*/*): requested one site at a time, only when the user chooses "Hide ads on" and the site's name in the popup.
- storage: the user's settings, filters and exceptions, stored on the device.
- scripting: register Sifter's content script on a site the user has just turned on, and run it in tabs that were already open when Sifter was installed or updated, so the user doesn't have to reload them. Only Sifter's own packaged script is injected.
- activeTab: read the current tab's hostname so the popup can offer to turn Sifter on there.
- contextMenus: the "Hide this post with Sifter" menu item.

## Remote code
No. Every script is in the package; nothing is fetched or evaluated at runtime.

## Privacy practices (dashboard answers)
Data handled on the device still has to be declared (User Data FAQ: disclosure applies
"even when data is processed or stored locally"). Tick:

- **Website content**: the text of posts on supported pages is read in the browser to
  find the site's own labels and the user's filter matches; posts the user marks
  "Not an ad" or hides are stored as a hash of their text. Never transmitted.
- **Personally identifiable information**: on LinkedIn, only while the user has turned
  "Suggested" on, the user's own profile id (the `/in/` part of their profile link) is
  stored so posts that mention them are never hidden. The setting discloses this next
  to the switch, before it is learned; turning "Suggested" off deletes it. Never
  transmitted.

Leave every other category unticked. Certify all three: not sold or transferred to
third parties; not used for purposes unrelated to the single purpose; not used for
creditworthiness or lending. The privacy policy states the Limited Use compliance.

## Trader status (EU)
The dashboard asks whether the publisher is a trader under the EU Digital Services
Act. That is Daniel's declaration to make, not something to fill in from here; a
trader must also show a verified address and phone number on the listing.

## Support
Support URL: https://github.com/danieljpuusitalo/sifter/issues
Homepage URL: https://github.com/danieljpuusitalo/sifter (also the manifest `homepage_url`)

## Assets

Generated by `pnpm store:assets` (`scripts/store-assets.mjs`) into `docs/store/`,
from the synthetic fixtures only, never a real account's feed. Re-run after any UI change.

- `screenshot-1-feed.png` (1280x800): the LinkedIn fixture, without and with Sifter
- `screenshot-2-popup.png` (1280x800): the popup, with real counts from the fixture tab
- `screenshot-3-options.png` (1280x800): the settings page
- `promo-small-440x280.png`: small promo tile

Privacy policy URL: https://danieljpuusitalo.github.io/sifter/privacy/ (built by
`.github/workflows/pages.yml`; GitHub Pages only serves once the repo is public or
on a paid plan).
