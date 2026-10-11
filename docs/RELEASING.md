# Releasing Sifter

A release is one command and one merge. Everything after the merge is automatic.

## The routine

1. **Check the live sites** (optional, two to four minutes; worth doing when a site
   looks off or before a bigger release). Close the dev Edge window first.

   ```
   pnpm build && pnpm canary
   ```

   One line per site: `PASS` (ads hidden, none missed), `INFO` (no ad served this run),
   `WARN` (logged out, or blocked by Google, so nothing was tested), `FAIL` (the site
   changed its markup, or an ad reached the screen uncovered). It cannot see a real post
   hidden by mistake: only your own eyes catch that.

2. **Say what changed.** Under `## [Unreleased]` in `CHANGELOG.md`, write it for users,
   in plain words. This text becomes the GitHub release notes. Commit it via a normal PR,
   or as part of the fix itself.

3. **Open the release PR**, from `main`, clean and pulled:

   ```
   pnpm release patch      # 1.2.0 -> 1.2.1: fixes, a site's selectors changed
   pnpm release minor      # 1.2.0 -> 1.3.0: new behaviour or a new setting
   pnpm release patch --dry   # show what would happen, change nothing
   ```

   It bumps the version, dates the changelog, and opens a `Release v1.2.1` PR. CI and
   the macOS/Windows compat run start on it.

4. **Merge the PR when it is green.** The Release workflow then re-runs every check,
   tags `v1.2.1`, publishes a GitHub Release with `sifter-1.2.1-chrome.zip`, and submits
   that zip to the Chrome Web Store. The update goes live by itself once Google approves
   it, usually within a day (up to three). Installed copies update within a few hours of
   that.

Do not push `v*` tags by hand: the workflow creates them, and a tag that already exists
makes it skip the release.

## Store rules that shape this

- **One review at a time.** While a version is pending review, the store refuses the next
  upload. The store job then fails. Once the review clears, open the failed run and press
  **Re-run failed jobs**: that resubmits the same zip, no new release needed. Releasing
  daily works, but batching a day's fixes into one release reviews faster than queueing.
- **New permissions disable Sifter for existing users.** If an update asks for a new
  permission or site, Chrome turns the extension off for everyone until they accept the
  new warning, and most never do. `check-permissions` in CI fails any build whose access
  differs from `permissions.lock.json`. A new site belongs behind the optional permission
  the popup already asks for ("Hide ads on <site>"), not in `src/sites.ts`. If a new
  required permission really must ship: `pnpm build && pnpm check:permissions --update`,
  commit the lock, and release it on its own with a changelog note saying why.
- **There is no rollback.** To undo a bad release, revert the change and release a higher
  version (`pnpm release patch`). The version must always go up.
- **Emergency:** if a pending submission is broken, cancel it in the developer dashboard
  (the item's Package tab), then merge the fix and release again.
- **Staged rollout** is possible: the dashboard can publish an approved version to a
  percentage of users first. Not used by default.

## One-time setup: let the workflow submit to the store

Until this is done, the store job does nothing except leave a note on the run. Upload the
zip from the GitHub Release by hand on the dashboard's Package tab instead.

The first submission is always by hand, because it creates the store item and its ID.
After that:

1. **Google Cloud project.** At console.cloud.google.com create a project (e.g. "sifter
   publish"), then enable the **Chrome Web Store API** for it.
2. **OAuth consent screen:** External, app name "sifter publish", your email. Then
   **Publish app** so its status reads **In production**. In "Testing", Google expires the
   refresh token after 7 days and the store job starts failing a week later.
3. **OAuth client:** Credentials, Create credentials, OAuth client ID, type **Desktop
   app**. Note the client ID and secret.
4. **Refresh token:** on this machine run `npx chrome-webstore-upload-keys` and follow
   it with the client ID and secret. Sign in with the account that owns the developer
   dashboard. It prints a refresh token.
5. **IDs:** the extension ID is on the item's page in the dashboard (32 letters). The
   publisher ID is under Account in the dashboard.
6. **GitHub secrets.** In the repo, Settings, Secrets and variables, Actions, add:

   | Secret | Value |
   |---|---|
   | `CWS_CLIENT_ID` | from step 3 |
   | `CWS_CLIENT_SECRET` | from step 3 |
   | `CWS_REFRESH_TOKEN` | from step 4 |
   | `CWS_PUBLISHER_ID` | from step 5 |
   | `CWS_EXTENSION_ID` | from step 5 |

   Or from a terminal: `gh secret set CWS_CLIENT_ID` (it prompts for the value; never
   paste a secret into a command line or a chat).

To test it without a release, run the Release workflow from the Actions tab
(`workflow_dispatch`); it skips when the current version is already tagged, so it only
proves the check job. The real proof is the next release's store job going green.

The upload uses `chrome-webstore-upload-cli`, pinned to an exact version in
`release.yml`. It sees the store credentials, so bump that pin deliberately, after
reading its changelog, never to "latest".

## When a user reports a site broke

The issue form ("A site broke") asks for the site, whether an ad got through or a real
post was hidden, and the Sifter version. Reproduce with `pnpm canary --sites <site>`,
then fix the adapter in `src/adapters/<site>.json` (usually one selector) with a fixture
and a test, as `CLAUDE.md` describes. Ship it as a patch.
