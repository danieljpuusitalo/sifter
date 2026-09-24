// Builds the GitHub Pages site into _site/: the privacy policy, converted from
// PRIVACY.md, plus a one-paragraph index that links to it and the repo.
// `pnpm pages` runs this locally; the pages.yml workflow runs it on push.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { marked } from 'marked';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '_site');
const REPO_URL = 'https://github.com/danieljpuusitalo/sifter';

const STYLE = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  h1, h2 { line-height: 1.2; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  a { color: #1f6f5c; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

mkdirSync(join(OUT, 'privacy'), { recursive: true });

const privacyMd = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');
const privacyHtml = page('Sifter privacy policy', marked.parse(privacyMd));
writeFileSync(join(OUT, 'privacy', 'index.html'), privacyHtml);

copyFileSync(join(ROOT, 'docs', 'store', 'screenshot-1-feed.png'), join(OUT, 'feed.png'));

const indexHtml = page(
  'Sifter: hide sponsored posts',
  `<h1>Sifter</h1>
<p>A Chrome extension that hides the ads your ad blocker misses: sponsored posts and
promoted results inside the feed. Ad blockers work on the network, and these units
are served by the site itself, so Sifter reads the label the site shows instead and
collapses the post. Everything runs in your browser.</p>
<img src="feed.png" alt="The same feed without and with Sifter" style="width:100%;height:auto;border-radius:6px">
<ul>
  <li><a href="${REPO_URL}">Source and install instructions on GitHub</a></li>
  <li><a href="${REPO_URL}/releases/latest">Latest release</a></li>
  <li><a href="privacy/">Privacy policy</a></li>
</ul>`,
);
writeFileSync(join(OUT, 'index.html'), indexHtml);
