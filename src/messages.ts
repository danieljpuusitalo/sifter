import { DEFAULT_CATEGORIES, type BlockCategory, type CategoryToggles, type HideCategory, type HideMode, type OverrideAction } from './types';
import type { TraceStats } from './content/trace';
import type { LateStats } from './content/viewport';

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
  | { type: 'sifter:pause'; minutes: number | null }
  /** Options page: the global category toggles, the hide-mode radio, and the filters form. */
  | { type: 'sifter:setCategory'; category: BlockCategory; value: boolean }
  | { type: 'sifter:setHideMode'; mode: HideMode }
  | { type: 'sifter:setFilters'; mutedWords: string[]; rulesText: string };

/** Popup -> content script in the active tab. */
export type TabRequest =
  | { type: 'sifter:getPageState' }
  /** Bench only: zero the peak counters so the next getPageState reports one window. */
  | { type: 'sifter:resetPerfPeaks' }
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
  /** No scan is queued or running: the counts above are the settled answer, not a snapshot mid-slice. */
  settled: boolean;
  /** A full scan found a substantial feed root but matched zero units in it: this site's rules may be stale. */
  noUnitsMatched: boolean;
  /** Scanner self-cost on this page (hard rule 7), for the popup and the scroll bench. */
  perf: ScanPerf;
  /** Dev and bench builds only: hide latency and flips (content/trace.ts). */
  trace?: TraceStats;
};

export type SliceProfile = {
  /** Carried writes from the previous slice, then prune and collect (0 when no collect ran). */
  carriedMs: number;
  collectMs: number;
  decideMs: number;
  applyMs: number;
  /** Units examined, units fully decided, hides/unhides written, and the slice's budget. */
  units: number;
  decided: number;
  applied: number;
  budget: number;
};

export type ScanPerf = {
  scans: number;
  /** Scans that re-collected the whole page (start, settings change, or a flood of mutations). */
  fullScans: number;
  /** processUnit calls, including ones the change signature skipped. */
  unitsExamined: number;
  /** Units that went through marker detection. */
  unitsDecided: number;
  /** Units whose marker element was already hidden by something other than Sifter (another ad blocker's cosmetic filter): skipped, never hidden, never placeheld. */
  foreignHidden: number;
  /** Units skipped because they held no text, media or link (an empty ad shell): never hidden, released if they empty after a hide. */
  emptySkipped: number;
  /** Times `decide` or `apply` threw for a unit: caught, skipped, counted, warned once. */
  decideErrors: number;
  /** Release passes (pause, a switch turned off, Show all) that scrolled back to keep the reader's post in place. */
  releaseCorrections: number;
  slices: number;
  totalMs: number;
  /** Longest slice, including the collect step it started with. `resetPerfPeaks` zeroes it. */
  maxSliceMs: number;
  /** Time spent mapping mutations to units and modules (the "collect" step inside a slice). */
  collectMs: number;
  maxCollectMs: number;
  /** The single most expensive decision (one unit's reads). `resetPerfPeaks` zeroes it. */
  maxDecideMs: number;
  /** Where the longest slice's time went, so an overrun names its phase. */
  worstSlice: SliceProfile | null;
  /** Slices that ran past 1.5x the 8 ms budget: each one is a frame at risk. */
  slicesOverBudget: number;
  /** Units still queued for a decision right now. */
  pending: number;
  /** Pre-paint lane (scanner.ts): units born in a mutation batch that it looked at. */
  laneUnits: number;
  /** Of those, hidden before their first paint. */
  laneHits: number;
  /** Marker found, but the lane would not decide alone (hidden label, empty unit, not a hide): left to the debounced pass. */
  laneAbstain: number;
  /** Batches whose born units did not all fit the lane's 1 ms: the rest went to the next frame's continuation. */
  laneOverBudget: number;
  /** Of `laneHits`, hidden in that same-frame continuation (still before their first paint). */
  laneFrameHits: number;
  /** Continuations that did not fit their own 1 ms either: the rest were queued for the debounced pass, watched for nearness. */
  laneFrameOverBudget: number;
  /** Debounces cut short because a queued unit came within a screen of the reader. */
  approachScans: number;
  /** Idle slices, waiting the long timeout, promoted because a queued unit came within a screen while slices ran. */
  approachPromotes: number;
  /** Lane hides the full decision then disagreed with, released in place. Target 0: each is a rule-6 near miss. */
  laneReleases: number;
  laneMs: number;
  /** The lane's longest single batch. `resetPerfPeaks` zeroes it. */
  laneMaxMs: number;
  /** Label nodes that paid a style read (checkVisibility, or the computed-style walk): each can force the page's pending style recalc. Page-wide, cumulative. */
  labelStyleReads: number;
  /** Label nodes settled on raw text, with no style read. Page-wide, cumulative. */
  labelReadsSkipped: number;
} & LateStats;

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
