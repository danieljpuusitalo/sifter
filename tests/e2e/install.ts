import type { BrowserContext } from '@playwright/test';

/**
 * On first install the background opens the options page, and Chrome may put it
 * in the context's initial blank tab, which interrupts a test's first goto (seen
 * in CI: "Navigation ... is interrupted by another navigation to
 * chrome-extension://.../options.html"). Wait for it to land, or give up after a
 * short timeout when it went elsewhere.
 */
export async function settleInstall(context: BrowserContext): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (context.pages().some((p) => p.url().includes('options.html'))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
