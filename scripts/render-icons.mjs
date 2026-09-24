// Renders assets/icon.svg to public/icon/{16,32,48,128}.png with Playwright's
// Chromium. Run after editing the SVG: `node scripts/render-icons.mjs`.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../assets/icon.svg', import.meta.url), 'utf8');
const out = new URL('../public/icon/', import.meta.url);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
    );
    await page.screenshot({ path: new URL(`${size}.png`, out).pathname.replace(/^\/([A-Za-z]:)/, '$1'), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('icons written to public/icon/');
