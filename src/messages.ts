import { DEFAULT_CATEGORIES, type BlockCategory, type CategoryToggles, type HideCategory, type HideMode, type OverrideAction } from './types';

// Message contract between contexts. Content scripts never touch storage; they
// ask the service worker (see src/storage/settings.ts for why).

export type SiteContext = {
  siteKey: string;
  enabled: boolean;
  pausedUntil: number | null;
  hideMode: HideMode;
  overrides: Record<string, OverrideAction>;
  /** What to hide on this site (global toggles with the site's own on top). */
  categories: CategoryToggles;
  /** The user's element rules that apply to this site. */
  customSelectors: string[];
  mutedWords: string[];
  /** The adapter's suggested rules switched off on this site. */
  offRules: string[];
};

/** Content script / popup -> service worker. */
export type BgRequest =
  | { type: 'sifter:getContext'; hostname: string }
  | { type: 'sifter:setOverride'; hostname: string; fp: string; action: OverrideAction | null }
  | { type: 'sifter:setSiteEnabled'; hostname: string; enabled: boolean }
  | { type: 'sifter:setSiteCategory'; hostname: string; category: BlockCategory; value: boolean | null }
  | { type: 'sifter:setSiteRule'; hostname: string; rule: string; value: boolean }
  | { type: 'sifter:pause'; minutes: number | null };

/** Popup -> content script in the active tab. */
export type TabRequest =
  | { type: 'sifter:getPageState' }
  | { type: 'sifter:refresh' }
  | { type: 'sifter:showAll' }
  /** From the context menu: hide the post that was right-clicked, and remember it. */
  | { type: 'sifter:hideTarget' };

export type PageState = {
  siteKey: string;
  enabled: boolean;
  paused: boolean;
  adapter: string; // adapter id or "generic"
  units: number;
  counts: Partial<Record<HideCategory, number>>;
  /** Categories in force on this page, so the popup can show the toggles. */
  categories: CategoryToggles;
  /** Whether this site's rules can detect suggested posts at all. */
  canSuggest: boolean;
  /** This site's named suggested rules, each with whether it is on here. */
  rules: { id: string; label: string; on: boolean }[];
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

/** A site context with every default in place. For tests, evals and the bench. */
export function defaultContext(siteKey: string, over: Partial<SiteContext> = {}): SiteContext {
  return {
    siteKey,
    enabled: true,
    pausedUntil: null,
    hideMode: 'collapse',
    overrides: {},
    categories: { ...DEFAULT_CATEGORIES },
    customSelectors: [],
    mutedWords: [],
    offRules: [],
    ...over,
  };
}
