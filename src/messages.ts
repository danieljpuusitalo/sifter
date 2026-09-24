import type { HideCategory, HideMode, OverrideAction } from './types';

// Message contract between contexts. Content scripts never touch storage; they
// ask the service worker (see src/storage/settings.ts for why).

export type SiteContext = {
  siteKey: string;
  enabled: boolean;
  pausedUntil: number | null;
  hideMode: HideMode;
  overrides: Record<string, OverrideAction>;
};

/** Content script / popup -> service worker. */
export type BgRequest =
  | { type: 'sifter:getContext'; hostname: string }
  | { type: 'sifter:setOverride'; hostname: string; fp: string; action: OverrideAction | null }
  | { type: 'sifter:setSiteEnabled'; hostname: string; enabled: boolean }
  | { type: 'sifter:pause'; minutes: number | null };

/** Popup -> content script in the active tab. */
export type TabRequest = { type: 'sifter:getPageState' } | { type: 'sifter:refresh' } | { type: 'sifter:showAll' };

export type PageState = {
  siteKey: string;
  enabled: boolean;
  paused: boolean;
  adapter: string; // adapter id or "generic"
  units: number;
  counts: Partial<Record<HideCategory, number>>;
  hiddenNow: number;
};

export function isBgRequest(m: unknown): m is BgRequest {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string' && (m as { type: string }).type.startsWith('sifter:');
}
