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
    // The 128 px icon is the store and install-dialog icon: the Web Store asks for
    // 96 px of artwork inside 16 px of transparent padding. The SVG's rounded square
    // is 120 of its 128 units, so draw the SVG at 128 * 96/120 px, centred. The
    // toolbar sizes stay full-bleed, where every pixel counts.
    const draw = size === 128 ? (128 * 96) / 120 : size;
    const pad = (size - draw) / 2;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{width:${draw}px;height:${draw}px;display:block;margin:${pad}px}</style>${svg}`,
    );
    await page.screenshot({ path: new URL(`${size}.png`, out).pathname.replace(/^\/([A-Za-z]:)/, '$1'), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('icons written to public/icon/');
