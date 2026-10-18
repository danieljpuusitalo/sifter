# Sifter privacy policy

Last updated: 2026-10-18

Published at https://danieljpuusitalo.github.io/sifter/privacy/

**Sifter sends nothing anywhere.** It has no server, no account, no analytics and
no tracking, and it makes no network requests of its own. What it reads and the
little it stores stay on your device; nothing is sent to the developer or to anyone
else.

## What Sifter reads

On the sites where it runs, Sifter reads the page in your browser to find posts the
site labels as sponsored, suggested or promoted, and posts matching filters you set.
That reading happens on your device. No page content, browsing history or personal
data is sent anywhere.

## What Sifter stores

Sifter stores the following in your browser's extension storage (`chrome.storage.local`)
on your device:

- your settings (what to block, which sites, how hidden posts look)
- your muted words and element rules
- posts you marked "Not an ad" or hid yourself. These are stored as a short
  fingerprint (a hash) of the post's text, not the text itself.
- on LinkedIn, and only while "Suggested" is turned on for LinkedIn, your own
  profile id: the part of your profile link after `linkedin.com/in/`, which often
  contains your name. Sifter reads it from the profile links in the sidebar of your
  LinkedIn feed, and only when at least two of them agree.

**Why the profile id.** With "Suggested" turned on, Sifter hides posts that reach
you only because a connection liked or commented on them. A post that mentions or
tags you can arrive the same way, and hiding it would mean you never see that
someone mentioned you. Sifter keeps your profile id so it can recognise a post that
links to your profile and always leave it visible. It is only compared against links
on the page, in your browser.

"Suggested" is off by default, and the setting says, next to the switch, that
turning it on keeps your profile link. Turning "Suggested" off for LinkedIn, or
turning LinkedIn off in Sifter, deletes the id. You can also see it, and remove it,
under Options, "Your exceptions", with the Forget button; while "Suggested" stays
on, Sifter learns it again the next time you open the feed.

This data never leaves your browser unless you export a backup file yourself; a
backup contains all of the above, including the profile id. Uninstalling Sifter
deletes it.

## How this data is used

Sifter uses this data only to decide what to hide on your screen. It does not sell
or transfer it, does not use it for advertising, credit or any purpose unrelated to
hiding posts, and no person reads it. Sifter's use of data complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including its Limited Use requirements.

## Permissions and why

| Permission | Why |
|---|---|
| Access to linkedin.com, reddit.com, x.com, twitter.com, instagram.com, facebook.com, threads.com, threads.net, google.com and 18 Google country domains (google.nl, google.de, google.co.uk, …; the full list is `GOOGLE_DOMAINS` in `src/sites.ts`). Chrome grants this per domain, so it covers every page on them; on Google, Sifter's rules are written for the search results page | to find and hide sponsored posts on those sites |
| Other sites (optional, only when you ask) | when you choose "Hide ads on" and the site's name in the popup, Chrome asks you to grant that one site |
| `storage` | to keep your settings on your device |
| `scripting` | to start Sifter on a site you turned on from the popup, and on tabs that were already open when Sifter was installed or updated, without a reload |
| `activeTab` | to show the current site's name in the popup |
| `contextMenus` | for "Hide this post with Sifter" on right-click |

## Changes

Changes to this policy are recorded in the
[project's history](https://github.com/danieljpuusitalo/sifter/commits/main/PRIVACY.md).

## Contact

Questions: daniel.jpuusitalo@gmail.com
