import type { Adapter } from './schema';

/**
 * Every selector string an adapter can pass to `querySelector`/`querySelectorAll`/
 * `matches` at runtime, in one place. Shared by the adapter validity test
 * (happy-dom) and the Playwright selector canary (real Chromium): happy-dom
 * silently accepts selectors Chrome may reject, so both need the same list.
 */
export function allSelectors(adapter: Adapter): string[] {
  const out: string[] = [adapter.unitSelector];
  if (adapter.feedRootSelector) out.push(adapter.feedRootSelector);
  if (adapter.textRootSelector) out.push(adapter.textRootSelector);
  out.push(...adapter.labelSelectors);
  if (adapter.labelIgnoreSelector) out.push(adapter.labelIgnoreSelector);
  out.push(...adapter.adSelectors);
  if (adapter.adContainerSelector) out.push(adapter.adContainerSelector);
  if (adapter.suggested) {
    out.push(...adapter.suggested.selectors);
    if (adapter.suggested.labelSelectors) out.push(...adapter.suggested.labelSelectors);
    for (const rule of adapter.suggested.rules) out.push(...rule.selectors);
  }
  for (const b of adapter.blocks) {
    out.push(b.selector);
    if (b.anchor) out.push(b.anchor);
  }
  return out;
}
