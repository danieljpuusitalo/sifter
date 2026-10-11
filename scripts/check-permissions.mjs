// Fails when the built manifest asks for different access than permissions.lock.json.
//
// Why it exists: when an update adds a permission, a host or a content-script match that
// carries a new install warning, Chrome DISABLES the extension for every existing user
// until they open chrome://extensions and accept the new prompt. Most never do, so the
// update quietly loses them. Adding a site to src/sites.ts (a Google country domain
// included) is exactly that change. New sites belong behind the optional permission the
// popup already requests ("Hide ads on <site>"), which disables nobody.
//
// Usage (after `pnpm build`):
//   node scripts/check-permissions.mjs           check, exit 1 on any difference
//   node scripts/check-permissions.mjs --update  rewrite the lock (only for a change you mean)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST = resolve('.output/chrome-mv3/manifest.json');
const LOCK = resolve('permissions.lock.json');

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch {
  console.error(`No built manifest at ${MANIFEST}: run \`pnpm build\` first.`);
  process.exit(2);
}

const sorted = (xs) => [...new Set(xs ?? [])].sort();
const current = {
  permissions: sorted(manifest.permissions),
  host_permissions: sorted(manifest.host_permissions),
  optional_permissions: sorted(manifest.optional_permissions),
  optional_host_permissions: sorted(manifest.optional_host_permissions),
  content_script_matches: sorted((manifest.content_scripts ?? []).flatMap((c) => c.matches ?? [])),
};

if (process.argv.includes('--update')) {
  writeFileSync(LOCK, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${LOCK}. Commit it, and say in the PR why the access changed.`);
  process.exit(0);
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const added = [];
const removed = [];
for (const key of Object.keys(current)) {
  const was = new Set(lock[key] ?? []);
  const now = new Set(current[key]);
  for (const x of now) if (!was.has(x)) added.push(`${key}: ${x}`);
  for (const x of was) if (!now.has(x)) removed.push(`${key}: ${x}`);
}

if (added.length === 0 && removed.length === 0) {
  console.log(`permissions: unchanged (${current.permissions.length} permissions, ${current.host_permissions.length} hosts)`);
  process.exit(0);
}
if (added.length) {
  console.error('The manifest asks for MORE access than permissions.lock.json:');
  for (const x of added) console.error(`  + ${x}`);
  console.error(
    [
      '',
      'On the Chrome Web Store, an update that adds a required permission or host disables',
      'Sifter for every existing user until they accept the new warning. Most never do.',
      'For a new site, use the optional permission the popup requests instead of src/sites.ts.',
      'If this really must ship, run `node scripts/check-permissions.mjs --update`, commit the',
      'lock, and release it on its own with a note in the changelog.',
    ].join('\n'),
  );
}
if (removed.length) {
  console.error('The manifest asks for LESS access than permissions.lock.json (harmless for users):');
  for (const x of removed) console.error(`  - ${x}`);
  console.error('Run `node scripts/check-permissions.mjs --update` and commit the lock.');
}
process.exit(1);
