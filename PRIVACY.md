# Sifter privacy policy

Last updated: 2026-09-24

Published at https://danieljpuusitalo.github.io/sifter/privacy/

**Sifter collects nothing.** It has no server, no account, no analytics and no
tracking, and it makes no network requests of its own.

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

This data never leaves your browser unless you export a backup file yourself.
Uninstalling Sifter deletes it.

## Permissions and why

| Permission | Why |
|---|---|
| Access to linkedin.com, reddit.com, x.com, twitter.com, instagram.com, facebook.com, threads.com, threads.net, and Google Search on google.com plus 18 country domains (google.nl, google.de, google.co.uk, …; the full list is `GOOGLE_DOMAINS` in `src/sites.ts`) | to find and hide sponsored posts on those sites |
| Other sites (optional, only when you ask) | when you choose "Hide ads on this site" in the popup, Chrome asks you to grant that one site |
| `storage` | to keep your settings on your device |
| `scripting` | to start Sifter on a site you've just turned on, without a reload |
| `activeTab` | to show the current site's name in the popup |
| `contextMenus` | for "Hide this post with Sifter" on right-click |

## Contact

Questions: daniel@4impact.vc
