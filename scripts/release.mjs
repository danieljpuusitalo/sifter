// Opens the release PR for the next version. Merging that PR is the release:
// .github/workflows/release.yml sees a version with no tag on main, verifies, tags it,
// publishes the GitHub Release with the zip, and submits the zip to the Chrome Web Store.
//
//   pnpm release patch        1.2.0 -> 1.2.1 (fixes, selector updates)
//   pnpm release minor        1.2.0 -> 1.3.0 (new behaviour)
//   pnpm release patch --dry  print what would happen, change nothing
//
// Needs: on main, clean, level with origin/main; something under ## [Unreleased] in
// CHANGELOG.md (that text becomes the release notes); `gh` logged in.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const bump = process.argv[2];
const dry = process.argv.includes('--dry');
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
if (!['patch', 'minor', 'major'].includes(bump)) die('usage: pnpm release <patch|minor|major> [--dry]');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const git = (...args) => run('git', args);

if (git('branch', '--show-current') !== 'main') die('switch to main first.');
if (git('status', '--porcelain')) die('the working tree has changes; commit or stash them first.');
git('fetch', '--quiet', 'origin', 'main', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) die('main is not level with origin/main; pull first.');

const pkgText = readFileSync('package.json', 'utf8');
const from = JSON.parse(pkgText).version;
const [maj, min, pat] = from.split('.').map(Number);
const to = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
if (git('tag', '--list', `v${to}`)) die(`tag v${to} already exists.`);
if (!git('tag', '--list', `v${from}`)) die(`v${from} has no tag yet: the last release has not landed, so finish that first.`);

const log = readFileSync('CHANGELOG.md', 'utf8');
const eol = log.includes('\r\n') ? '\r\n' : '\n';
const head = '## [Unreleased]';
const at = log.indexOf(head);
if (at < 0) die(`CHANGELOG.md has no "${head}" heading.`);
const after = log.slice(at + head.length);
const next = after.search(/\r?\n## \[/);
const notes = (next < 0 ? after : after.slice(0, next)).trim();
if (!notes) die('nothing under ## [Unreleased] in CHANGELOG.md. Write what changed for users first; it becomes the release notes.');

const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const newLog = `${log.slice(0, at)}${head}${eol}${eol}## [${to}] - ${date}${after}`;
const newPkg = pkgText.replace(`"version": "${from}"`, `"version": "${to}"`);
if (newPkg === pkgText) die('could not find the version field in package.json.');

const branch = `release/${to}`;
console.log(`release: ${from} -> ${to} on ${branch}\n\n${notes}\n`);
if (dry) {
  console.log('release: --dry, nothing changed.');
  process.exit(0);
}

git('switch', '-c', branch);
writeFileSync('package.json', newPkg);
writeFileSync('CHANGELOG.md', newLog);
git('add', 'package.json', 'CHANGELOG.md');
git('commit', '--quiet', '-m', `release: v${to}`);
git('push', '--quiet', '-u', 'origin', branch);
const body = [
  `Release v${to}. **Merging this publishes it:** the Release workflow tags \`v${to}\`, attaches \`sifter-${to}-chrome.zip\` to a GitHub Release, and submits it to the Chrome Web Store for review.`,
  '',
  '## Changes',
  '',
  notes,
].join('\n');
let url = '';
try {
  url = run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release v${to}`, '--body', body]);
} catch {
  // gh has already printed why.
}
git('switch', '--quiet', 'main');
if (!url) die(`${branch} is pushed but the PR was not opened; open it on GitHub, or run \`gh pr create --head ${branch} --fill\`.`);
console.log(`release: opened ${url}`);
console.log('release: CI and the macOS/Windows compat run start on it. Merge when green; the rest is automatic.');
