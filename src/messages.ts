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
  /** Scanner self-cost on this page (hard rule 7), for the popup and the scroll bench. */
  perf: ScanPerf;
};

export type ScanPerf = {
  scans: number;
  /** Scans that re-collected the whole page (start, settings change, or a flood of mutations). */
  fullScans: number;
  /** processUnit calls, including ones the change signature skipped. */
  unitsExamined: number;
  /** Units that went through marker detection. */
  unitsDecided: number;
  slices: number;
  totalMs: number;
  maxSliceMs: number;
  /** Slices that ran past 1.5x the 8 ms budget: each one is a frame at risk. */
  slicesOverBudget: number;
  /** Units still queued for a decision right now. */
  pending: number;
};

export function isBgRequest(m: unknown): m is BgRequest {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string' && (m as { type: string }).type.startsWith('sifter:');
}
