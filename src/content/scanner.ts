import { findGenericUnits, innermost } from '../adapters/generic';
import type { Adapter } from '../adapters/schema';
import { detectMarker, hasContent, labelReadCounts, mutedWordRendered, unitText } from '../extract';
import { changeSignature, fingerprint } from '../fingerprint';
import type { PageState, ScanPerf, SiteContext } from '../messages';
import { mutedWordHit, mutedWordPattern, tooBroad } from '../rules/filters';
import { decideTier0 } from '../rules/tier0';
import type { BlockCategory, HideCategory, OverrideAction } from '../types';
import { keepInPlace } from './anchor';
import { Hider, PLACEHOLDER_ATTR } from './hider';
import type { NearTracker } from './near';
import { EMPTY_LATE_STATS, type LateStats, type LateTracker, type LateTrackerFactory } from './viewport';
import { safeDetail, type HideTrace, type HideWhy } from './trace';

// Content-script pipeline: extract -> fingerprint -> tier 0 -> apply
// (BRIEF.md §5). Tier 1 (model) plugs in at the "unknown" branch in M2.
//
// Scrolling must stay smooth (hard rule 7), so the scanner:
//  - looks only at units a mutation touched, never re-walks the whole feed
//    (the old full rescan grew with the page: 600 cards meant 600 checks per scan);
//  - does all of its DOM work, the collect step included, in idle callbacks after
//    a frame is painted, in slices of about 4 ms (half of rule 7's 8), and stops a slice before the
//    unit that would overrun it rather than after;
//  - decides a slice with DOM reads only, then applies its hides in one write pass,
//    so a hide never forces the next unit's read to lay the page out again;
//  - never evaluates a `:has()` block rule against feed posts: anchored blocks are
//    found from a cheap anchor inside the module and a walk up its ancestors.
// `pnpm bench:scroll` measures frames with the extension off and on.

const DEBOUNCE_MS = 250; // hard rule 7
/** The pre-paint lane's cap per mutation batch (hard rule 7's exception): what does not fit waits for the debounced pass. */
export const LANE_BUDGET_MS = 1;
/** The generic extractor re-derives units from the whole page, so it runs less often. */
const GENERIC_DEBOUNCE_MS = 1000;
/** Hard rule 7's ceiling on main-thread work per batch; `slicesOverBudget` counts against it. */
const HARD_RULE_MS = 8;
/**
 * What a slice actually aims for: half the ceiling. An idle slice that fits its
 * idle period costs a frame nothing, but the page's own work can take that period
 * back mid-slice, and then whatever is left of the slice lands on a frame. Shorter
 * slices make that overlap small. Measured on live LinkedIn (bench/live.ts), an
 * 8 ms cap let the worst slice run to 6-7 ms mid-scroll.
 */
const SLICE_BUDGET_MS = 4;
/** An idle callback that fired on its timeout got no idle time: take a small bite. */
const STARVED_BUDGET_MS = 2;
const IDLE_TIMEOUT_MS = 200;
/**
 * The idle timeout while the reader may be about to see the result: the collect
 * after a debounce (its units are unplaced yet), and a queue whose head is near the
 * viewport. Live LinkedIn (2026-10-01) is busy 500-800 ms of every second, so a
 * slice there almost always starts on its timeout and decides one unit: at 200 ms
 * that wait was most of a hide landing on screen (idle p50 201 ms, p90 575 ms; the
 * queue after the collect up to 750 ms). The work is the same, only sooner.
 */
const PROMPT_IDLE_TIMEOUT_MS = 50;
/**
 * The decide-cost estimate before any unit has been measured. Starting at zero let
 * the first slice after page load (cold code, a page whose styles are all dirty)
 * decide until it had already overrun; a warm decision costs well under this.
 */
const DECIDE_COST_PRIOR_MS = 1;
/** Past this many dirty nodes, one full collection is cheaper than mapping each. */
const MAX_DIRTY = 1500;
/** Distinct units counted for the popup; past this the count stops growing (memory). */
const MAX_UNITS_SEEN = 5000;
/** How far up from an anchor a module may sit before the walk gives up. */
const MAX_ANCHOR_CLIMB = 24;

export type ScannerDeps = {
  doc: Document;
  hostname: string;
  baseUrl: string;
  adapter: Adapter | null;
  context: SiteContext;
  persistOverride: (fp: string, action: OverrideAction | null) => void;
  /**
   * The page's current URL path. Single-page sites navigate without reloading, so
   * the content script passes a live reader; the default is `baseUrl`'s path.
   */
  path?: () => string;
  now?: () => number;
  /** Dev builds log batches that exceed the time budget. */
  dev?: boolean;
  /** Test hook: run the debounce and slices through this instead of timers and idle callbacks. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Test hook: the lane's same-frame continuation runs through this instead of requestAnimationFrame. */
  frame?: (fn: () => void) => unknown;
  /**
   * Where late hides sit relative to the reader (viewport.ts). With it, a hide
   * decided after the post was drawn is tagged in place unless it is far below, so
   * the feed never moves under the reader. Without it, hides apply at once.
   */
  viewport?: LateTrackerFactory;
  /** False switches the pre-paint lane off even where the adapter asks for it (tests). */
  prepaint?: boolean;
  /** Dev and bench builds: hide latency and flips (trace.ts). Absent in a release. */
  trace?: HideTrace;
  /** Which queued units are near the viewport (near.ts): those are decided first. Without it, document order. */
  near?: NearTracker;
};

type Seen = { sig: string; fp: string };
/** A unit the pre-paint lane hides, with what the hide records. */
type LaneHit = { unit: Element; category: HideCategory; hint?: string; why: HideWhy };
/** A whole page module hidden by rule: an adapter block, or one of the user's element rules. */
type Block = { selector: string; category: BlockCategory; innermost?: boolean; anchor?: string; rule?: string };
type Decision = {
  unit: Element;
  fp: string;
  hide: HideCategory | null;
  block?: boolean;
  hint?: string;
  /** For the trace: what made it a hide, without page text. */
  why?: HideWhy;
  /** A release because the unit emptied. */
  empty?: boolean;
  /** A new hide that will land as a tag: the `display: contents` boxes its blur must reach, read here so the write phase never reads style. */
  contents?: Element[];
};

/** Past this many characters a placeholder's hint is post body, not a label. */
const MAX_HINT = 60;

/** The first non-empty rendered line of an already-extracted unit text, capped for the placeholder. */
function firstHint(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.trim());
  const trimmed = line?.trim();
  return trimmed ? trimmed.slice(0, MAX_HINT) : undefined;
}

/** For category "custom", the placeholder says why, not the post's first line. */
function wordHint(word: string): string {
  return `muted word “${word}”`.slice(0, MAX_HINT);
}

/** Same, for a custom hide from an element rule (a whole matched module). */
function ruleHint(selector: string): string {
  return `rule ${selector}`.slice(0, MAX_HINT);
}

/**
 * For a suggested hide, the placeholder names the switch that hid it ("People
 * and pages you don't follow"), not the post's first line: a post can match two
 * rules at once (liked by a connection, from someone you don't follow), and the
 * user has to see which switch is still on when they turn one off.
 */
function suggestedHint(adapter: Adapter | null, rule: string | undefined): string | undefined {
  if (!rule) return undefined;
  const label = adapter?.suggested?.rules.find((r) => r.id === rule)?.label;
  return label ? label.slice(0, MAX_HINT) : undefined;
}

/** The counters a scanner keeps itself; the rest of ScanPerf is read at snapshot time. */
type OwnPerf = Omit<ScanPerf, 'pending' | 'labelStyleReads' | 'labelReadsSkipped' | keyof LateStats>;

const EMPTY_PERF: OwnPerf = {
  scans: 0,
  fullScans: 0,
  unitsExamined: 0,
  unitsDecided: 0,
  foreignHidden: 0,
  emptySkipped: 0,
  decideErrors: 0,
  releaseCorrections: 0,
  slices: 0,
  totalMs: 0,
  maxSliceMs: 0,
  collectMs: 0,
  maxCollectMs: 0,
  maxDecideMs: 0,
  worstSlice: null,
  slicesOverBudget: 0,
  laneUnits: 0,
  laneHits: 0,
  laneAbstain: 0,
  laneOverBudget: 0,
  laneFrameHits: 0,
  laneFrameOverBudget: 0,
  approachScans: 0,
  approachPromotes: 0,
  laneReleases: 0,
  laneMs: 0,
  laneMaxMs: 0,
  laneBilledMaxMs: 0,
};

export class Scanner {
  private hider: Hider;
  private seen = new WeakMap<Element, Seen>();
  private userShown = new WeakSet<Element>();
  private hiddenFps = new Map<string, HideCategory>();
  private unitsSeen = new Set<string>();
  private observer: MutationObserver | null = null;
  private debounceTimer: unknown = null;
  private pending: Element[] = [];
  private queued = new Set<Element>();
  /** The near tracker's version the queue was last ordered by. */
  private orderedAt = -1;
  private running = false;
  /** The idle callback the next slice waits on, and whether it waits the prompt timeout. */
  private sliceHandle: number | null = null;
  private slicePrompt = false;
  /** A scan was requested: the next slice starts by collecting units. */
  private needCollect = false;
  /** Hides a slice decided but ran out of budget to write; applied first thing next slice. */
  private carried: Decision[] = [];
  /** Running cost of one fully decided unit (a moving average), the slice's stopping estimate. */
  private decideCostMs = DECIDE_COST_PRIOR_MS;
  private settleWaiters: (() => void)[] = [];
  /** Elements hidden because a block rule matched them, which may not be feed units at all. */
  private blockHidden = new WeakMap<Element, string>();
  /** The rule each collected module was collected for, so decide() never re-matches posts against block rules. */
  private blockFor = new WeakMap<Element, Block>();
  // What changed since the last scan. `touched` nodes changed in place, so the
  // unit around them is dirty; `added` subtrees may also hold whole new units.
  private touched = new Set<Node>();
  private added = new Set<Element>();
  private needFull = true;
  private perf: OwnPerf = { ...EMPTY_PERF };
  private ctx: SiteContext;
  /** Blocks in force for the current context. */
  private blocks: Block[] = [];
  /** Blocks found from an anchor, and blocks found by their own selector (joined into one). */
  private anchored: Block[] = [];
  private plain: Block[] = [];
  private plainSelector: string | null = null;
  private muted: RegExp | null = null;
  private offRules: ReadonlySet<string> = new Set();
  /** The context's categories, with "suggested" off on pages outside the adapter's feed paths. */
  private categories: SiteContext['categories'];
  /** Compiled `suggestedPaths`; null means suggested applies on every page. */
  private readonly feedPaths: RegExp[] | null;
  private readonly path: () => string;
  /** The path the categories were compiled for: a change is an in-app navigation. */
  private lastPath = '';
  /** One throwing unit must not spam the console: warn once per page. */
  private decideErrorWarned = false;
  /** A full scan found the feed root but no units in it: this site's adapter may be stale. */
  private noUnitsMatched = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  /** A selector decide() reads inside a unit counts siblings, so the placeholder must be out of the way (see decide). */
  private readonly positional: boolean;
  private readonly late: LateTracker | null;
  /** The adapter runs the pre-paint lane (see `prepaint`). */
  private readonly lane: boolean;
  /** Hidden by the lane and not yet confirmed by `decide()`: a disagreement releases in place. */
  private laneHidden = new WeakSet<Element>();
  /** Born units the lane has read, so its same-frame continuation never reads one twice. */
  private laneLooked = new WeakSet<Element>();
  /** Batches the 1 ms cap cut, for the next frame's continuation (`carryLane`). */
  private laneCarry: MutationRecord[] = [];
  private laneCarryUnits: Element[] = [];
  private laneFrame = false;
  private readonly frame: (fn: () => void) => unknown;
  /**
   * A pass the user started (pause, a switch, "Not an ad", an in-app navigation):
   * its writes keep the reader's post in place, and a new hide in it applies at once
   * instead of as a tag, because the reader asked for it (a switch turned on must
   * visibly work). Cleared when the queue drains, so the scroll-time path never pays
   * the forced layout that costs (hard rule 7).
   */
  private releasing = false;

  constructor(private deps: ScannerDeps) {
    this.ctx = deps.context;
    this.categories = deps.context.categories;
    this.feedPaths = compilePaths(deps.adapter?.suggestedPaths);
    this.path = deps.path ?? (() => pathOf(deps.baseUrl));
    this.positional = positionalSelectors(deps.adapter);
    this.now = deps.now ?? (() => performance.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const win = deps.doc.defaultView;
    this.frame = deps.frame ?? (win ? (fn) => win.requestAnimationFrame(() => fn()) : (fn) => setTimeout(fn, 0));
    const trace = deps.trace;
    this.late =
      deps.viewport?.(
        (unit, why) => {
          this.hider.settle(unit);
          trace?.wrote(unit, why ?? 'farBelow', this.now());
        },
        trace ? { cost: (k, ms) => trace.cost(k, ms) } : undefined,
      ) ?? null;
    // A unit inside an ad-only container is hidden as the container, which the lane never sees born.
    this.lane = deps.prepaint !== false && !!deps.adapter?.prepaint && !deps.adapter.adContainerSelector;
    this.hider = new Hider(
      deps.doc,
      deps.context.hideMode,
      {
        onShow: (unit) => this.userShow(unit),
        onNotAd: (unit) => this.userNotAd(unit),
        onRehide: (unit) => this.userRehide(unit),
        onHideTag: (unit) => {
          // Hide on a tag the reader opened with Show: back in the count, then collapsed like any tag.
          if (this.userShown.has(unit)) this.userRehide(unit);
          this.inPlace(() => this.hider.settle(unit));
          trace?.wrote(unit, 'click', this.now());
        },
      },
      this.late ?? undefined,
      trace ? (k, ms) => trace.cost(k, ms) : undefined,
    );
    deps.near?.listen?.(() => this.approach());
    this.compileContext();
  }

  /** Derive what the context implies once, not per unit. */
  private compileContext(): void {
    const { customSelectors, mutedWords } = this.ctx;
    this.lastPath = this.path();
    const onFeed = !this.feedPaths || this.feedPaths.some((re) => re.test(this.lastPath));
    const categories = { ...this.ctx.categories, suggested: this.ctx.categories.suggested && onFeed };
    this.categories = categories;
    // Older service workers answer without offRules while the extension updates.
    this.offRules = new Set(this.ctx.offRules ?? []);
    const blocks: Block[] = [];
    for (const b of this.deps.adapter?.blocks ?? []) {
      if (categories[b.category] && !(b.rule && this.offRules.has(b.rule))) blocks.push(b);
    }
    if (categories.custom) {
      // Syntax check against an empty fragment: a whole-document query here would
      // cost a page walk per rule at start.
      const probe = this.deps.doc.createDocumentFragment();
      for (const selector of customSelectors) {
        // The options page validates rules, but storage is data: re-check before use (hard rule 2).
        if (tooBroad(selector)) continue;
        try {
          probe.querySelector(selector);
          blocks.push({ selector, category: 'custom' });
        } catch {
          /* invalid selector: skip it */
        }
      }
    }
    this.blocks = blocks;
    this.anchored = blocks.filter((b) => b.anchor);
    this.plain = blocks.filter((b) => !b.anchor);
    this.plainSelector = this.plain.length ? this.plain.map((b) => b.selector).join(', ') : null;
    this.blockFor = new WeakMap();
    this.muted = categories.custom ? mutedWordPattern(mutedWords) : null;
  }

  get active(): boolean {
    return this.ctx.enabled && !(this.ctx.pausedUntil !== null && this.ctx.pausedUntil > Date.now());
  }

  start(): void {
    const target = this.deps.doc.body ?? this.deps.doc.documentElement;
    this.observer = new MutationObserver((records) => this.onMutations(records));
    // characterData: React rewrites text in place (nodeValue), with no childList record.
    this.observer.observe(target, { childList: true, subtree: true, characterData: true });
    this.scanNow();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.deps.near?.disconnect();
    this.unhideAllInPlace();
    this.hider.dispose();
  }

  /** Every hide released, the reader's post kept in place. In a trace build, each write is attributed. */
  private unhideAllInPlace(): void {
    const traced = this.deps.trace ? this.hider.trackedHides() : null;
    this.inPlace(() => this.hider.unhideAll());
    if (traced) for (const u of traced) this.deps.trace?.wrote(u, 'user', this.now());
  }

  /** New settings from the popup or options: re-decide everything on the page. */
  applyContext(ctx: SiteContext): void {
    this.ctx = ctx;
    this.compileContext();
    const traced = this.deps.trace ? this.hider.trackedHides() : null;
    this.hider.setMode(ctx.hideMode);
    if (traced) for (const u of traced) this.deps.trace?.wrote(u, 'mode', this.now());
    this.seen = new WeakMap();
    if (!this.active) {
      // Drop queued work too: a slice already scheduled must not hide anything now.
      this.dropQueue();
      this.hiddenFps.clear();
      this.unhideAllInPlace();
      this.markFull();
      this.noUnitsMatched = false;
      return;
    }
    // Hidden elements a full scan may no longer collect (a block whose category or
    // rule was just switched off) still need a fresh decision, to be shown again.
    this.releasing = true;
    for (const u of this.hider.trackedHides()) this.enqueue(u);
    this.scanNow();
  }

  /** Resolves once queued work is done, so a caller reading state() sees the result. */
  settled(): Promise<void> {
    if (!this.running && this.debounceTimer === null) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  /** Bench hook: zero the peak counters so the next state() reports one window. */
  resetPerfPeaks(): void {
    this.perf.maxSliceMs = 0;
    this.perf.maxCollectMs = 0;
    this.perf.maxDecideMs = 0;
    this.perf.worstSlice = null;
    this.perf.laneMaxMs = 0;
    this.perf.laneBilledMaxMs = 0;
    this.deps.trace?.reset();
  }

  private enqueue(u: Element): void {
    if (this.queued.has(u)) return;
    this.queued.add(u);
    this.pending.push(u);
    this.deps.near?.watch(u);
  }

  /**
   * A queued unit came within a screen of the reader: decide it promptly. While the
   * debounce still runs, scan now instead. The lane queues the units its budget cut
   * (`laneContinue`), and a unit on screen at mutation time waited the whole debounce
   * in the open: live LinkedIn, 2026-10-03, 6 of 108 hides were readable first, all
   * lane overflow, for 375 ms p50 and 1.8 s at worst. Units far away keep the debounce.
   * While slices already run, promote a slice waiting the long idle timeout: the queue
   * puts the near unit first, but on a starved page each slice then waited 200 ms.
   */
  private approach(): void {
    const { near } = this.deps;
    if (!this.active || !near) return;
    if (this.debounceTimer === null && !this.running) return;
    if (!this.pending.some((u) => near.isNear(u))) return;
    if (this.debounceTimer === null) {
      if (this.sliceHandle !== null && !this.slicePrompt) {
        this.perf.approachPromotes++;
        this.nextSlice(true);
      }
      return;
    }
    this.debounceTimer = null;
    this.perf.approachScans++;
    this.deps.trace?.due(this.now());
    this.scanNow(false);
  }

  /** Units near the viewport first, each group in document order. Only when nearness changed. */
  private nearFirst(): void {
    const { near } = this.deps;
    if (!near || near.version === this.orderedAt || this.pending.length < 2) return;
    this.orderedAt = near.version;
    const close: Element[] = [];
    const rest: Element[] = [];
    for (const u of this.pending) (near.isNear(u) ? close : rest).push(u);
    if (close.length && rest.length) this.pending = close.concat(rest);
  }

  private dropQueue(): void {
    const { near } = this.deps;
    if (near) for (const u of this.pending) near.unwatch(u);
    this.pending = [];
    this.queued.clear();
    this.carried = [];
    this.needCollect = false;
  }

  /** A user override changed: re-decide the whole page, so copies of the same post follow it. */
  private redecideAll(): void {
    this.seen = new WeakMap();
    this.releasing = true;
    for (const u of this.hider.trackedHides()) this.enqueue(u);
    this.scanNow();
  }

  /**
   * The context menu's "Hide this post": the nearest unit around the clicked
   * element is hidden now and on every later visit. Returns false when the click
   * wasn't inside anything Sifter knows as a post.
   */
  hideContaining(target: Element | null): boolean {
    for (let el = target; el; el = el.parentElement) {
      const seen = this.seen.get(el);
      if (!seen) continue;
      this.ctx = { ...this.ctx, overrides: { ...this.ctx.overrides, [seen.fp]: 'hide' } };
      this.deps.persistOverride(seen.fp, 'hide');
      this.userShown.delete(el);
      this.hiddenFps.set(seen.fp, 'manual');
      // The reader asked for it: collapse now, not as a tag, and keep their place.
      this.inPlace(() => this.hider.hide(el, 'manual', undefined, true));
      this.deps.trace?.wrote(el, 'click', this.now());
      this.redecideAll();
      return true;
    }
    return false;
  }

  showAll(): void {
    this.inPlace(() => {
      for (const u of this.hider.trackedHides()) this.userShow(u);
    });
  }

  /** Runs writes that change heights across the page, then scrolls back so the reader's post has not moved. */
  private inPlace(writes: () => void): void {
    const delta = keepInPlace(this.deps.doc, this.anchorable, writes, this.deps.adapter?.feedRootSelector);
    if (delta === 0) return;
    this.perf.releaseCorrections++;
    this.deps.trace?.scrolled(delta, this.now());
  }

  /** A post the reader may be looking at: what `inPlace` anchors to. */
  private readonly anchorable = (el: Element): boolean =>
    this.hider.isHidden(el) || this.userShown.has(el) || (!!this.deps.adapter && this.isUnit(el));

  state(): PageState {
    const counts: PageState['counts'] = {};
    for (const cat of this.hiddenFps.values()) counts[cat] = (counts[cat] ?? 0) + 1;
    return {
      siteKey: this.ctx.siteKey,
      enabled: this.ctx.enabled,
      paused: this.ctx.enabled && !this.active,
      adapter: this.deps.adapter?.id ?? 'generic',
      units: this.unitsSeen.size,
      counts,
      categories: this.ctx.categories,
      canSuggest: !!this.deps.adapter?.suggested || !!this.deps.adapter?.blocks.some((b) => b.category === 'suggested'),
      rules: (this.deps.adapter?.suggested?.rules ?? []).map((r) => ({ id: r.id, label: r.label, on: !this.offRules.has(r.id) })),
      hiddenNow: this.hider.hiddenUnits().length,
      settled: !this.running && this.debounceTimer === null,
      noUnitsMatched: this.noUnitsMatched,
      perf: {
        ...this.perf,
        ...(this.late?.stats() ?? EMPTY_LATE_STATS),
        pending: this.pending.length + this.carried.length,
        labelStyleReads: labelReadCounts.styled,
        labelReadsSkipped: labelReadCounts.skipped,
      },
      ...(this.deps.trace ? { trace: this.deps.trace.stats() } : {}),
    };
  }

  /** Runs on every mutation batch, often mid-scroll: bookkeeping only, no DOM reads. */
  private onMutations(records: MutationRecord[]): void {
    const { trace } = this.deps;
    if (!trace) return this.onMutationsUntimed(records);
    // Trace builds only: the callback's cost outside the lane (the lane times itself).
    const t0 = this.now();
    const lane0 = this.perf.laneMs;
    this.onMutationsUntimed(records);
    trace.cost('mutations', Math.max(0, this.now() - t0 - (this.perf.laneMs - lane0)));
  }

  private onMutationsUntimed(records: MutationRecord[]): void {
    // An in-app navigation (LinkedIn feed -> company page) swaps the page without a
    // reload, and always mutates the DOM: re-decide everything under the new path.
    // Reading the location is a string, not a DOM read, so this costs nothing per batch.
    if (this.feedPaths && this.path() !== this.lastPath) {
      this.applyContext(this.ctx);
      return;
    }
    if (this.lane && this.active) this.prepaint(records);
    let relevant = false;
    for (const r of records) {
      if (isOwnMutation(r)) continue;
      relevant = true;
      if (this.needFull) continue;
      this.touched.add(r.target);
      const added = r.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (n && n.nodeType === 1) this.added.add(n as Element);
      }
      if (this.touched.size + this.added.size > MAX_DIRTY) this.markFull();
    }
    if (relevant) {
      this.deps.trace?.dirty(this.now());
      this.requestScan();
    }
  }

  private markFull(): void {
    this.needFull = true;
    this.touched.clear();
    this.added.clear();
  }

  requestScan(): void {
    if (this.debounceTimer !== null) return;
    // A token, not the timer's handle: `approach` supersedes a pending debounce by replacing it.
    const token = {};
    this.debounceTimer = token;
    this.schedule(
      () => {
        if (this.debounceTimer !== token) return;
        this.debounceTimer = null;
        this.deps.trace?.due(this.now());
        this.scanNow(false);
      },
      this.deps.adapter ? DEBOUNCE_MS : GENERIC_DEBOUNCE_MS,
    );
  }

  /**
   * Ask for a scan: the next idle slice collects units (the whole page when
   * `full`: start, settings change; otherwise only what mutations touched), then
   * the slices work through them, each within ~4 ms. Nothing touches the DOM here,
   * so the debounce timer task stays empty.
   */
  scanNow(full = true): void {
    if (!this.active) {
      this.markFull();
      this.settle();
      return;
    }
    this.perf.scans++;
    this.deps.trace?.dirty(this.now());
    if (full) this.markFull();
    this.needCollect = true;
    if (!this.running) {
      this.running = true;
      this.nextSlice(true);
    } else if (this.sliceHandle !== null) {
      this.nextSlice(true);
    }
  }

  private settle(): void {
    if (this.debounceTimer !== null || this.running) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  private collectUnits(): Element[] {
    const { touched, added, needFull: full } = this;
    this.needFull = false;
    this.touched = new Set();
    this.added = new Set();
    if (full) this.perf.fullScans++;
    const root = this.deps.doc.body;
    if (!root) return [];
    const { adapter } = this.deps;
    const blocks = this.collectBlocks(root, full, touched, added);
    if (!adapter) return [...this.collectGeneric(root, full, touched, added), ...blocks];
    try {
      const units = full
        ? innermost(withoutPlaceholders(root.querySelectorAll(adapter.unitSelector)))
        : dirtyUnits(adapter.unitSelector, touched, added);
      if (full) this.updateNoUnitsMatched(root, Array.isArray(units) ? units.length : units.size);
      const out = adapter.adContainerSelector ? collapseToContainers(units, adapter.adContainerSelector) : [...units];
      return blocks.length ? [...out, ...blocks] : out;
    } catch {
      return blocks;
    }
  }

  /**
   * A local "rules may be stale" signal (no telemetry, hard rule 1): the feed root
   * exists and clearly holds content (more than 5 element children), but a full
   * scan's unitSelector matched nothing in it. A quiet page (feed still loading,
   * or genuinely empty) does not trip this; a feed root with a fat body and zero
   * matches usually means the site's markup moved under the adapter.
   */
  private updateNoUnitsMatched(root: Element, matchedCount: number): void {
    const selector = this.deps.adapter?.feedRootSelector;
    if (!selector) {
      this.noUnitsMatched = false;
      return;
    }
    let feedRoot: Element | null;
    try {
      feedRoot = root.querySelector(selector);
    } catch {
      this.noUnitsMatched = false;
      return;
    }
    this.noUnitsMatched = !!feedRoot && feedRoot.children.length > 5 && matchedCount === 0;
  }

  /**
   * Page modules the block rules match. An anchored rule is found from its anchor
   * (a simple selector, cheap in `closest` and in a dirty subtree) and a walk up to
   * the first ancestor the rule matches: innermost by construction, and the rule's
   * `:has()` only ever runs against that module's own ancestors. Rules without an
   * anchor are found by their selector, the same dirty-only way as units.
   */
  private collectBlocks(root: Element, full: boolean, touched: Set<Node>, added: Set<Element>): Element[] {
    if (this.blocks.length === 0) return [];
    const out = new Set<Element>();
    for (const b of this.anchored) {
      for (const anchor of collectMatches(root, b.anchor as string, full, touched, added)) {
        const m = this.moduleAround(anchor, b, root);
        if (m) {
          this.blockFor.set(m, b);
          out.add(m);
        }
      }
    }
    if (this.plainSelector) {
      const found = collectMatches(root, this.plainSelector, full, touched, added);
      for (const el of this.innermostBlocks(found, root)) {
        const b = this.blockOf(el, this.plain);
        if (!b) continue;
        this.blockFor.set(el, b);
        out.add(el);
      }
    }
    return [...out];
  }

  /** The module around an anchor: the nearest ancestor the rule matches, or the farthest when the rule is not `innermost`. */
  private moduleAround(anchor: Element, b: Block, root: Element): Element | null {
    let found: Element | null = null;
    let el: Element | null = anchor;
    for (let i = 0; el && el !== root && i < MAX_ANCHOR_CLIMB; el = el.parentElement, i++) {
      if (safeMatches(el, b.selector)) {
        found = el;
        if (b.innermost) break;
      }
    }
    return found;
  }

  /** Drop ancestors an `innermost` block rule matched only because the module is inside them. */
  private innermostBlocks(found: Element[], root: Element): Element[] {
    if (!this.plain.some((b) => b.innermost)) return found;
    // Compare against every match in the document, not el.querySelector(): a rule
    // that starts outside el ("[role=complementary] div:has(…)") is not reliably
    // found by a query scoped to el, and a false "no descendant" hides the column.
    const all = new Map<Block, Element[]>();
    return found.filter((el) => {
      const b = this.blockOf(el, this.plain);
      if (!b?.innermost) return true;
      let matches = all.get(b);
      if (!matches) {
        try {
          matches = Array.from(root.querySelectorAll(b.selector));
        } catch {
          matches = [];
        }
        all.set(b, matches);
      }
      return !matches.some((m) => m !== el && el.contains(m));
    });
  }

  /** The block rule an element matches, if any. */
  private blockOf(el: Element, blocks: Block[] = this.blocks): Block | null {
    for (const b of blocks) if (safeMatches(el, b.selector)) return b;
    return null;
  }

  /** No adapter: units come from page structure, so re-derive them, then keep only new or changed ones. */
  private collectGeneric(root: Element, full: boolean, touched: Set<Node>, added: Set<Element>): Element[] {
    const units = findGenericUnits(root);
    if (full) return units;
    const set = new Set(units);
    const dirty = new Set<Element>();
    for (const u of units) if (!this.seen.has(u)) dirty.add(u);
    const mark = (n: Node) => {
      for (let el: Element | null = n.nodeType === 1 ? (n as Element) : n.parentElement; el; el = el.parentElement) {
        if (set.has(el)) {
          dirty.add(el);
          return;
        }
      }
    };
    touched.forEach(mark);
    added.forEach(mark);
    return [...dirty];
  }

  /**
   * Runs the next slice in idle time, after the current frame is painted, so it never
   * delays one. `prompt` waits for idle time only `PROMPT_IDLE_TIMEOUT_MS`, and
   * promotes a slice already waiting the long timeout (one slice chain, never two).
   */
  private nextSlice(prompt: boolean): void {
    if (this.deps.schedule) {
      this.deps.schedule(() => this.runSlice(SLICE_BUDGET_MS), 0);
      return;
    }
    const view = this.deps.doc.defaultView;
    if (!view || typeof view.requestIdleCallback !== 'function') {
      setTimeout(() => this.runSlice(SLICE_BUDGET_MS), 0);
      return;
    }
    if (this.sliceHandle !== null) {
      if (!prompt || this.slicePrompt) return;
      view.cancelIdleCallback(this.sliceHandle);
    }
    this.slicePrompt = prompt;
    this.sliceHandle = view.requestIdleCallback(
      (d) => {
        this.sliceHandle = null;
        this.runSlice(d.didTimeout ? STARVED_BUDGET_MS : Math.min(SLICE_BUDGET_MS, Math.max(1, d.timeRemaining())));
      },
      { timeout: prompt ? PROMPT_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS },
    );
  }

  /** The reader may see the next slice's result: a collect is due, or the queue's head is near the viewport. */
  private promptNext(): boolean {
    if (this.needCollect) return true;
    const head = this.pending[0];
    return !!head && !!this.deps.near?.isNear(head);
  }

  /**
   * One slice: write what the last slice could not, collect if a scan is due,
   * decide units while the budget lasts (DOM reads only), then apply the hides in
   * one pass (DOM writes only). Interleaving reads and writes would make each read
   * after a hide lay the page out again. The decide loop stops *before* the unit
   * that would overrun, judged by this slice's average cost per unit.
   */
  private runSlice(budget: number): void {
    if (!this.active) {
      this.dropQueue();
      this.running = false;
      this.releasing = false;
      this.settle();
      return;
    }
    const start = this.now();
    const carried = this.carried;
    this.carried = [];
    this.applyAll(carried);
    const carriedMs = this.now() - start;
    let collected = false;
    let collectMs = 0;
    if (this.needCollect) {
      this.needCollect = false;
      collected = true;
      const t0 = this.now();
      this.hider.prune();
      const { trace } = this.deps;
      trace?.sweep(t0);
      if (trace) trace.classesKept(this.hider.trackedHides());
      const since = trace?.takeDirty(t0) ?? t0;
      for (const u of this.collectUnits()) {
        // Our own placeholder can match a unit selector (X's cells are bare divs).
        if (u.hasAttribute(PLACEHOLDER_ATTR)) continue;
        // Still queued (the lane queued it early): its wait already runs.
        if (this.queued.has(u)) continue;
        this.enqueue(u);
        trace?.queued(u, since, t0, this.pending.length - 1);
      }
      collectMs = this.now() - t0;
      this.perf.collectMs += collectMs;
      this.perf.maxCollectMs = Math.max(this.perf.maxCollectMs, collectMs);
    }
    const decisions: Decision[] = [];
    const decideStart = this.now();
    const decidedAtStart = this.perf.unitsDecided;
    this.nearFirst();
    let i = 0;
    while (i < this.pending.length) {
      const elapsed = this.now() - start;
      // Always make progress: one unit, unless this slice already did something
      // (a collect, or carried writes). The next unit is assumed to cost what a
      // fully decided one has cost so far: most units are unchanged and near free,
      // so an in-slice average would wave through the one that is not.
      if (i > 0 || collected || carried.length > 0) {
        if (elapsed + this.decideCostMs > budget) break;
      }
      const unit = this.pending[i++] as Element;
      this.queued.delete(unit);
      this.deps.near?.unwatch(unit);
      const decidedBefore = this.perf.unitsDecided;
      const t0 = this.now();
      const d = this.decideSafely(unit);
      if (this.perf.unitsDecided > decidedBefore) {
        const cost = this.now() - t0;
        this.perf.maxDecideMs = Math.max(this.perf.maxDecideMs, cost);
        // One sample counts for at most a whole slice: on a live feed a decision
        // that collection lands in (a 25 ms MajorGC, 2026-10-04) says nothing about
        // the next unit, and unclamped it held the estimate past the budget for
        // several slices, one unit each. A steady cost at or past the budget still
        // reads as a full slice per unit, as before.
        this.decideCostMs = this.decideCostMs * 0.7 + Math.min(cost, SLICE_BUDGET_MS) * 0.3;
      }
      if (d) decisions.push(d);
    }
    this.pending = i >= this.pending.length ? [] : this.pending.slice(i);
    const decideMs = this.now() - decideStart;
    // Writes: count against the budget too, and carry what does not fit.
    let applied = 0;
    const writes = () => {
      while (applied < decisions.length) {
        this.applySafely(decisions[applied++] as Decision);
        if (applied < decisions.length && this.now() - start >= budget) break;
      }
    };
    if (this.releasing && decisions.some(this.changesHeight)) this.inPlace(writes);
    else writes();
    if (applied < decisions.length) this.carried = decisions.slice(applied);
    const took = this.now() - start;
    this.perf.slices++;
    this.perf.totalMs += took;
    if (took > this.perf.maxSliceMs) {
      this.perf.worstSlice = {
        carriedMs: +carriedMs.toFixed(1),
        collectMs: +collectMs.toFixed(1),
        decideMs: +decideMs.toFixed(1),
        applyMs: +(took - carriedMs - collectMs - decideMs).toFixed(1),
        units: i,
        decided: this.perf.unitsDecided - decidedAtStart,
        applied,
        budget: +budget.toFixed(1),
      };
    }
    this.perf.maxSliceMs = Math.max(this.perf.maxSliceMs, took);
    if (took > HARD_RULE_MS * 1.5) this.perf.slicesOverBudget++;
    if (this.deps.dev && took > HARD_RULE_MS * 1.5) {
      console.warn(`[sifter] slice took ${took.toFixed(1)} ms for ${i} units${collected ? ' (with collect)' : ''}`);
    }
    if (this.pending.length > 0 || this.carried.length > 0 || this.needCollect) {
      this.nextSlice(this.promptNext() || (collected && this.pending.length > 0));
    } else {
      this.running = false;
      this.releasing = false;
      this.settle();
    }
  }

  /** In a user-started pass: a release, or a hide that collapses a unit now (see `releasing`). */
  private readonly changesHeight = (d: Decision): boolean => !d.hide || (!this.hider.isHidden(d.unit) && !this.hider.isTagged(d.unit));

  private applyAll(ds: Decision[]): void {
    const writes = () => {
      for (const d of ds) this.applySafely(d);
    };
    if (this.releasing && ds.some(this.changesHeight)) this.inPlace(writes);
    else writes();
  }

  /**
   * A bad adapter selector, or anything else `decide` or `apply` throws, must not
   * take the scanner down: `scanNow`'s `if (!this.running)` guard means a dead
   * `running` flag never schedules another slice, so the whole page would stop
   * being scanned. Record the unit as seen (its current signature) so a throwing
   * unit is not retried every slice, count the failure, and warn at most once.
   */
  private decideSafely(unit: Element): Decision | null {
    try {
      return this.decide(unit);
    } catch (e) {
      this.recordDecideError(e);
      const sig = changeSignature(unit.textContent ?? '');
      const fp = fingerprint(this.ctx.siteKey, structuralKey(unit));
      this.seen.set(unit, { sig, fp });
      return null;
    }
  }

  private applySafely(d: Decision): void {
    try {
      this.apply(d);
    } catch (e) {
      this.recordDecideError(e);
    }
  }

  private recordDecideError(e: unknown): void {
    this.perf.decideErrors++;
    if (this.decideErrorWarned) return;
    this.decideErrorWarned = true;
    console.warn('[sifter] decide failed', e);
  }

  /**
   * The pre-paint lane (hard rule 7's one exception to the debounce). A
   * MutationObserver callback runs after the site's script wrote the DOM and before
   * the browser paints it, so a unit hidden here is never drawn: its first paint is
   * already the collapsed bar, and nothing on screen moves.
   *
   * Only units born in this batch (an added root, or inside one). A unit reached
   * through `closest()` from a changed node may already be on screen; it takes the
   * debounced pass and, if it is a late catch, a tag. The reads are
   * `detectMarker`'s own (attributes and text, style only on a matched label node),
   * so the lane cannot disagree with `decide()` about a marker; it decides only on a
   * marker and the user's overrides, never on muted words or element rules. Capped
   * at `LANE_BUDGET_MS` per batch: what does not fit waits for the debounced pass,
   * which also confirms every lane hide and releases one it disagrees with.
   */
  private prepaint(records: MutationRecord[]): void {
    const { adapter } = this.deps;
    if (!adapter) return;
    const t0 = this.now();
    const clock = laneClock(this.now, t0);
    // The cap is asked before every further record and unit, never the first: one
    // record and one unit always fit, whatever a slow frame does to the clock.
    const { units: born, cut, next } = bornUnits(records, adapter.unitSelector, clock.over);
    if (born.length === 0 && !cut) return;
    const read = this.laneRun(born, adapter, clock);
    const overBudget = cut || read < born.length;
    if (overBudget) {
      this.perf.laneOverBudget++;
      this.carryLane(born.slice(read), records.slice(next));
    }
    this.laneTook(t0, clock);
    // Trace builds only, after the lane's clock stopped: re-mount bookkeeping.
    const { trace } = this.deps;
    if (trace) for (const u of born) trace.born(u);
  }

  /**
   * What the 1 ms cap cut from a batch gets one more 1 ms in the next animation
   * frame. rAF callbacks run before that frame's style, layout and paint, so a unit
   * hidden there is still never drawn. The read that pays a fresh batch's style
   * recalc is not billed (`laneClock`), so on LinkedIn this now runs mostly for
   * batches with many units or a slow collect. What does not fit then waits for the
   * debounced pass, as before.
   */
  private carryLane(units: Element[], records: MutationRecord[]): void {
    for (const u of units) this.laneCarryUnits.push(u);
    for (const r of records) this.laneCarry.push(r);
    if (this.laneFrame) return;
    this.laneFrame = true;
    this.frame(() => this.laneContinue());
  }

  private laneContinue(): void {
    this.laneFrame = false;
    const carried = this.laneCarryUnits;
    const records = this.laneCarry;
    this.laneCarryUnits = [];
    this.laneCarry = [];
    const { adapter, trace } = this.deps;
    if (!adapter || !this.lane || !this.active || !this.observer) return;
    const t0 = this.now();
    const clock = laneClock(this.now, t0);
    // Units already collected go first and cost no collect; the first of them is the
    // one read that always fits. Without one, the first record is.
    const todo = new Set(carried.filter((u) => u.isConnected && !this.laneLooked.has(u)));
    const { units: fresh, cut, next } = bornUnits(records, adapter.unitSelector, clock.over, todo.size > 0);
    for (const u of fresh) if (!this.laneLooked.has(u)) todo.add(u);
    const list = [...todo];
    const hitsBefore = this.perf.laneHits;
    const read = this.laneRun(list, adapter, clock);
    this.perf.laneFrameHits += this.perf.laneHits - hitsBefore;
    const overBudget = cut || read < list.length;
    if (overBudget) this.perf.laneFrameOverBudget++;
    this.laneTook(t0, clock);
    if (trace) for (const u of fresh) trace.born(u);
    if (!overBudget) return;
    // After the lane's clock stopped: queue the units the budget cut, so the near
    // tracker watches them and one coming near skips the debounce (`approach`). The
    // records not yet collected get a collect of their own, also capped; what that
    // cuts waits for the debounced pass's collect as before.
    const t1 = this.now();
    const rest = bornUnits(records.slice(next), adapter.unitSelector, () => this.now() - t1 > LANE_BUDGET_MS).units;
    if (trace) for (const u of rest) trace.born(u);
    const now = this.now();
    for (const u of new Set([...list.slice(read), ...rest])) {
      if (this.laneLooked.has(u) || u.hasAttribute(PLACEHOLDER_ATTR)) continue;
      trace?.laneSkipped(u, 'overflow');
      if (this.queued.has(u)) continue;
      this.enqueue(u);
      trace?.queued(u, now, now, this.pending.length - 1);
    }
  }

  /** Reads `born` in order until the clock is over (never before the first), then hides the hits. Returns how many it read. */
  private laneRun(born: Element[], adapter: Adapter, clock: LaneClock): number {
    const { baseUrl, trace } = this.deps;
    const hasOverrides = Object.keys(this.ctx.overrides).length > 0;
    const hits: LaneHit[] = [];
    let readUpTo = born.length;
    for (let i = 0; i < born.length; i++) {
      const u = born[i]!;
      if (i > 0 && clock.over()) {
        readUpTo = i;
        break;
      }
      this.laneLooked.add(u);
      if (this.hider.isHidden(u) || this.userShown.has(u) || this.seen.has(u)) continue;
      this.perf.laneUnits++;
      // A read that throws (a bad adapter selector) costs the lane this unit, never the
      // site's own callback: the debounced pass meets the same unit and handles it there.
      let hit: LaneHit | 'abstain' | null;
      const r0 = this.now();
      try {
        hit = this.laneRead(u, adapter, baseUrl, hasOverrides);
      } catch {
        hit = 'abstain';
      }
      clock.read(this.now() - r0);
      if (hit === 'abstain') {
        this.perf.laneAbstain++;
        trace?.laneSkipped(u, 'abstain');
      } else if (hit) hits.push(hit);
      // Trace builds only: an extra content check, to tell a shell filled later from a slow decide.
      else if (trace && !hasContent(u)) trace.bornBare(u);
    }
    // Writes after every read, so no hide forces the next unit's read to restyle.
    const now = this.now();
    for (const h of hits) {
      this.hider.hide(h.unit, h.category, h.hint, true);
      this.laneHidden.add(h.unit);
      trace?.hid(h.unit, now, h.why);
      trace?.wrote(h.unit, 'lane', now);
      this.perf.laneHits++;
    }
    return readUpTo;
  }

  /** One born unit's lane verdict: a hide, 'abstain' (a marker, but decide() might not hide), or null (no marker). */
  private laneRead(u: Element, adapter: Adapter, baseUrl: string, hasOverrides: boolean): LaneHit | 'abstain' | null {
    const { categories } = this;
    const marker = detectMarker(u, adapter, baseUrl, { suggested: categories.suggested, offRules: this.offRules });
    if (!marker) return null;
    // What decide() would skip (an empty shell, a label something else already hid)
    // the lane leaves to it: never a hide decide() would not make.
    if (!hasContent(u) || (!!marker.node && typeof marker.node.checkVisibility === 'function' && !marker.node.checkVisibility())) return 'abstain';
    let text: string | undefined;
    let override: OverrideAction | undefined;
    if (hasOverrides) {
      text = unitText(u, adapter);
      override = this.ctx.overrides[fingerprint(this.ctx.siteKey, text || structuralKey(u))];
    }
    const decision = decideTier0({ override, marker, custom: null, categories });
    if (decision.action !== 'hide') return 'abstain';
    const hint = (decision.category === 'suggested' ? suggestedHint(adapter, marker.rule) : undefined) ?? firstHint(text ?? unitText(u, adapter));
    const why: HideWhy = { category: decision.category, rule: marker.rule, kind: marker.kind, detail: safeDetail(marker.kind, marker.detail) };
    return { unit: u, category: decision.category, hint, why };
  }

  private laneTook(t0: number, clock: LaneClock): void {
    const took = this.now() - t0;
    this.perf.laneMs += took;
    if (took > this.perf.laneMaxMs) this.perf.laneMaxMs = took;
    const billed = took - clock.exempt;
    if (billed > this.perf.laneBilledMaxMs) this.perf.laneBilledMaxMs = billed;
  }

  /** DOM reads only. Returns null when nothing about the unit needs to change. */
  private decide(unit: Element): Decision | null {
    this.perf.unitsExamined++;
    if (!unit.isConnected) return null;
    const { adapter, baseUrl } = this.deps;
    // Fingerprints use the site key, so twitter.com and x.com share one identity.
    const site = this.ctx.siteKey;
    // Cheap change signal (no layout): sites recycle feed nodes for new content.
    const sig = changeSignature(unit.textContent ?? '');
    const prev = this.seen.get(unit);
    if (prev && prev.sig === sig) return null;
    // "Show" sticks to the element for the page session even if its text changes
    // (like counts tick). A recycled node may then miss an ad: rule 6's trade.

    // An empty shell hides nothing, whatever marks it: Google serves #tads and
    // friends empty on every page without ads, and a "Hidden" row over nothing is
    // a lie the user can see. No seen record, so the unit is decided afresh when it
    // fills in, even if its fill is image-only and leaves the text signature alone.
    if (!hasContent(unit)) {
      this.seen.delete(unit);
      this.perf.emptySkipped++;
      this.deps.trace?.empty(unit);
      // It emptied after a hide (or a Show): release it, placeholder and all.
      if (!this.hider.isHidden(unit) && !this.userShown.has(unit)) return null;
      return { unit, fp: prev?.fp ?? fingerprint(site, structuralKey(unit)), hide: null, empty: true };
    }

    this.perf.unitsDecided++;
    const { categories } = this;
    // A module keeps the rule it was collected for; a post never gets matched
    // against block rules. Only an element hidden as a module earlier, and not
    // collected as one now, pays for the full check (its rule may have gone off).
    let block = this.blockFor.get(unit) ?? null;
    if (block && !safeMatches(unit, block.selector)) {
      this.blockFor.delete(unit);
      block = null;
    }
    if (!block && this.blockHidden.has(unit)) block = this.blockOf(unit);
    if (block) {
      // One identity per rule: "Always show" on a block keeps all of that rule's modules.
      const fp = fingerprint(site, `block:${block.selector}`);
      this.seen.set(unit, { sig, fp });
      if (this.userShown.has(unit)) return null;
      const cat = block.category;
      const decision = decideTier0({
        override: this.ctx.overrides[fp],
        marker: cat === 'custom' ? null : { kind: 'structural', category: cat, detail: block.selector },
        custom: cat === 'custom' ? block.selector : null,
        categories,
      });
      if (decision.action === 'hide') {
        const hint = cat === 'custom' ? ruleHint(block.selector) : suggestedHint(adapter, block.rule);
        const why: HideWhy = { category: decision.category, rule: block.rule, kind: 'block', detail: block.selector };
        return { unit, fp, hide: decision.category, block: true, hint, why, contents: this.tagContents(unit) };
      }
      return this.hider.isHidden(unit) ? { unit, fp, hide: null } : null;
    }
    if (this.blockHidden.has(unit) && !this.isUnit(unit)) {
      // Its rule or category was switched off, and it isn't a post in its own right.
      return { unit, fp: this.blockHidden.get(unit) as string, hide: null };
    }
    // A rescan of a unit Sifter already collapsed reads it with the classes in
    // place: the style reads discount our own collapse (extract's collapsedByUs)
    // rather than un-hiding the post for the read, which cost a style recalc and a
    // forced layout of the whole post, twice.
    //
    // The placeholder is the unit's first child, so a selector that counts children
    // ("> div:first-child span") would miss the real header on a rescan and release
    // the unit, only to hide it again on the next pass. For adapters with such a
    // selector, read the unit as the site built it: lift the placeholder out for the
    // reads and put it straight back. Both moves are placeholder-only childList
    // records, which onMutations ignores. Other adapters skip the move, and the
    // style invalidation it costs.
    const placeholder = this.positional ? this.hider.placeholderOf(unit) : null;
    if (placeholder) placeholder.remove();
    let marker: ReturnType<typeof detectMarker>;
    let text: string;
    let foreignHidden: boolean;
    let custom: string | null;
    try {
      marker = detectMarker(unit, adapter, baseUrl, { suggested: categories.suggested, offRules: this.offRules });
      text = unitText(unit, adapter);
      // Something other than Sifter (another ad blocker's cosmetic filter, invisible
      // to the page CSSOM) already hid the element the marker matched. Hiding it
      // again would stack a placeholder on content the user can never get back with
      // Show, so treat the unit as already handled: no decision, ever, from this
      // marker. checkVisibility is a style pass, not layout (hard rule 7), and only
      // runs when a marker was found. happy-dom may lack it; then treat as visible.
      // A unit Sifter hid itself is never foreign: "hide" mode puts an inline
      // display:none on the unit itself, which checkVisibility would call foreign.
      foreignHidden =
        !this.hider.isHidden(unit) &&
        !!marker?.node &&
        typeof marker.node.checkVisibility === 'function' &&
        !marker.node.checkVisibility();
      // unitText also feeds the fingerprint, so it must read the same hidden or
      // shown (see its own comment); a custom hide must not fire on a word that
      // only exists in text a style hides, so confirm the hit is actually rendered.
      const wordHit = mutedWordHit(text, this.muted);
      custom = wordHit && this.muted && mutedWordRendered(unit, this.muted) ? wordHit : null;
    } finally {
      // A throwing read (decideSafely catches it) must not leave a hidden post's
      // placeholder detached: restore it before the error propagates.
      if (placeholder) unit.prepend(placeholder);
    }
    if (foreignHidden) {
      this.perf.foreignHidden++;
      const fp = fingerprint(site, text || structuralKey(unit));
      this.seen.set(unit, { sig, fp });
      return this.hider.isHidden(unit) ? { unit, fp, hide: null } : null;
    }
    // Skeleton units have no text yet; come back when they fill in, unless a
    // structural marker already settles it.
    if (!text && !marker) return null;
    const fp = fingerprint(site, text || structuralKey(unit));
    this.seen.set(unit, { sig, fp });
    if (this.unitsSeen.size < MAX_UNITS_SEEN) this.unitsSeen.add(fp);

    if (this.userShown.has(unit)) return null;
    const decision = decideTier0({
      override: this.ctx.overrides[fp],
      marker,
      custom,
      categories,
    });
    if (decision.action === 'hide') {
      const hint =
        decision.category === 'custom' && custom
          ? wordHint(custom)
          : (decision.category === 'suggested' ? suggestedHint(adapter, marker?.rule) : undefined) ?? firstHint(text);
      const kind = decision.category === 'custom' && custom ? 'muted' : marker?.kind;
      const why: HideWhy = { category: decision.category, rule: marker?.rule, kind, detail: safeDetail(kind, marker?.detail) };
      return { unit, fp, hide: decision.category, hint, why, contents: this.tagContents(unit) };
    }
    return this.hider.isHidden(unit) ? { unit, fp, hide: null } : null;
  }

  /**
   * A new hide that `apply` will land as a tag marks the unit's `display: contents`
   * boxes. Read them here, with the other reads, while style is clean: read after the
   * tag's own writes, they forced a style recalc of the post, once per tag.
   */
  private tagContents(unit: Element): Element[] | undefined {
    if (this.releasing || this.hider.isHidden(unit) || !this.hider.tagsLateHides()) return undefined;
    return this.hider.contentsOf(unit);
  }

  /** DOM writes only. */
  private apply(d: Decision): void {
    if (!d.unit.isConnected) return;
    if (this.userShown.has(d.unit)) {
      if (d.hide) return; // stays shown (with its "Hide" bar) until the user hides it again
      // The user showed it, and this decision no longer hides it at all (its
      // category or rule went off): drop the "Showing…" bar and the record.
      if (!this.releasing) this.deps.trace?.released(d.unit, this.now(), d.empty ? 'emptied' : 'redecided', true);
      this.userShown.delete(d.unit);
      this.hider.unhide(d.unit);
      this.deps.trace?.wrote(d.unit, 'release', this.now());
      this.hiddenFps.delete(d.fp);
      this.blockHidden.delete(d.unit);
      return;
    }
    if (d.hide) {
      if (!this.hider.isHidden(d.unit)) this.deps.trace?.hid(d.unit, this.now(), d.why ?? { category: d.hide });
      this.laneHidden.delete(d.unit);
      // A tag already on the page stays one: the reader is looking at it, not at the switch.
      const atOnce = this.releasing && !this.hider.isTagged(d.unit);
      this.hider.hide(d.unit, d.hide, d.hint, atOnce, d.contents);
      this.deps.trace?.wrote(d.unit, atOnce ? 'user' : 'decide', this.now());
      this.hiddenFps.set(d.fp, d.hide);
      if (d.block) this.blockHidden.set(d.unit, d.fp);
      else this.blockHidden.delete(d.unit);
    } else {
      if (!this.releasing && this.hider.isHidden(d.unit)) this.deps.trace?.released(d.unit, this.now(), d.empty ? 'emptied' : 'redecided', false);
      if (this.laneHidden.delete(d.unit)) {
        // The lane hid it before paint and the full decision disagrees: a rule-6 near
        // miss. Put it back without moving what the reader sees.
        this.perf.laneReleases++;
        this.inPlace(() => this.hider.unhide(d.unit));
        this.deps.trace?.wrote(d.unit, 'laneRelease', this.now());
      } else {
        this.hider.unhide(d.unit);
        this.deps.trace?.wrote(d.unit, 'release', this.now());
      }
      this.hiddenFps.delete(d.fp);
      this.blockHidden.delete(d.unit);
    }
  }

  /** Whether the adapter (or the generic finder) would collect this element as a post. */
  private isUnit(el: Element): boolean {
    const { adapter } = this.deps;
    if (!adapter) return findGenericUnits(this.deps.doc.body ?? el).includes(el);
    return safeMatches(el, adapter.unitSelector) || (!!adapter.adContainerSelector && safeMatches(el, adapter.adContainerSelector));
  }

  private userShow(unit: Element): void {
    this.userShown.add(unit);
    this.deps.trace?.shown(unit);
    const fp = this.seen.get(unit)?.fp;
    if (fp) this.hiddenFps.delete(fp);
    this.hider.show(unit);
    this.deps.trace?.wrote(unit, 'click', this.now());
  }

  /** "Hide" on a placeholder the user showed: puts the unit back into the count and the hidden state. */
  private userRehide(unit: Element): void {
    this.userShown.delete(unit);
    this.deps.trace?.unshown(unit);
    const fp = this.seen.get(unit)?.fp;
    const category = this.hider.categoryOf(unit);
    if (fp && category) this.hiddenFps.set(fp, category);
    this.hider.rehide(unit);
    this.deps.trace?.wrote(unit, 'click', this.now());
  }

  private userNotAd(unit: Element): void {
    const fp = this.seen.get(unit)?.fp;
    if (fp) {
      this.ctx = { ...this.ctx, overrides: { ...this.ctx.overrides, [fp]: 'not-ad' } };
      this.hiddenFps.delete(fp);
      this.deps.persistOverride(fp, 'not-ad');
    }
    // Hard reset, not the soft show: the placeholder is removed entirely and
    // the override is what keeps it from coming back, not the userShown bar.
    this.userShown.delete(unit);
    this.blockHidden.delete(unit);
    this.hider.unhide(unit);
    this.deps.trace?.wrote(unit, 'click', this.now());
    if (fp) this.redecideAll();
  }
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Whether any selector decide() runs inside a unit depends on sibling position,
 * which the placeholder (the unit's first child) shifts. Errs towards true: a
 * `~=` attribute match or a `+` in a word only costs the placeholder move.
 */
const POSITIONAL = /:(first|last|only|nth)-|:nth-|[+~]/;
export function positionalSelectors(adapter: Adapter | null): boolean {
  if (!adapter) return false;
  const { adSelectors, labelSelectors, labelIgnoreSelector, textRootSelector, suggested } = adapter;
  return POSITIONAL.test(JSON.stringify([adSelectors, labelSelectors, labelIgnoreSelector, textRootSelector, suggested]));
}

/** An adapter's `suggestedPaths`, compiled; an invalid pattern is dropped (the adapters test rejects it). */
function compilePaths(paths: string[] | undefined): RegExp[] | null {
  if (!paths) return null;
  const out: RegExp[] = [];
  for (const p of paths) {
    try {
      out.push(new RegExp(p));
    } catch {
      /* invalid pattern: skip it */
    }
  }
  return out;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/** Mutations that only add or remove our own placeholders must not trigger a rescan. */
function isOwnMutation(r: MutationRecord): boolean {
  if (r.type !== 'childList') return false;
  if (r.addedNodes.length + r.removedNodes.length === 0) return false;
  for (const list of [r.addedNodes, r.removedNodes]) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (!n || n.nodeType !== 1 || !(n as Element).hasAttribute(PLACEHOLDER_ATTR)) return false;
    }
  }
  return true;
}

/** A unit-selector query result, minus our own placeholders (they live inside the unit now, and can match a broad selector). */
function withoutPlaceholders(nodes: Iterable<Element>): Element[] {
  const out: Element[] = [];
  for (const n of nodes) if (!n.hasAttribute(PLACEHOLDER_ATTR)) out.push(n);
  return out;
}

/** Whether `el` holds another unit-selector match, ignoring its own placeholder (its first child, never a real unit). */
function hasInnerUnit(el: Element, selector: string): boolean {
  try {
    const matches = el.querySelectorAll(selector);
    for (let i = 0; i < matches.length; i++) {
      if (!matches[i]!.hasAttribute(PLACEHOLDER_ATTR)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The innermost units that contain a changed node or sit inside an added
 * subtree: the same answer innermost() gives over the whole page, restricted to
 * what changed. A unit is innermost exactly when it holds no other unit.
 */
function dirtyUnits(selector: string, touched: Set<Node>, added: Set<Element>): Set<Element> {
  const out = new Set<Element>();
  const consider = (u: Element | null | undefined) => {
    if (u && u.isConnected && !out.has(u) && !hasInnerUnit(u, selector)) out.add(u);
  };
  for (const n of touched) {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (el?.isConnected) consider(el.closest(selector));
  }
  for (const el of added) {
    if (!el.isConnected) continue;
    consider(el.closest(selector));
    const inner = el.querySelectorAll(selector);
    for (let i = 0; i < inner.length; i++) {
      const m = inner[i]!;
      if (!m.hasAttribute(PLACEHOLDER_ATTR)) consider(m);
    }
  }
  return out;
}

/**
 * The lane's 1 ms is billed from the start of the batch minus its single longest unit
 * read. On a live feed one read per batch pays the page's pending style recalc: the
 * first `checkVisibility` on a freshly inserted subtree, 4-70 ms on LinkedIn. That is
 * the page's own work, paid early (its next recalc then costs 0.1 ms; CHECKPOINT,
 * Phase 2 item 3), and the lane writes only after its last read, so every read after
 * it finds style clean. Billing it to the cap cut those cheap reads for nothing and
 * let their units paint. The longest read, not the first: the recalc lands on the
 * first unit that reaches a label node, which need not be the batch's first.
 */
type LaneClock = { over(): boolean; read(ms: number): void; readonly exempt: number };

function laneClock(now: () => number, t0: number): LaneClock {
  let exempt = 0;
  return {
    over: () => now() - t0 - exempt > LANE_BUDGET_MS,
    read: (ms) => {
      if (ms > exempt) exempt = ms;
    },
    get exempt() {
      return exempt;
    },
  };
}

/**
 * The innermost units born in this batch: an added element that is a unit, or a
 * unit inside one. Never `closest()`: a unit around an added node existed before
 * this batch and may already have been painted. `over()` is asked before every
 * record but the first (before the first too, with `askFirst`): `cut` says it
 * stopped there, with what it had found so far, and `next` is the first record it
 * did not read.
 */
export function bornUnits(
  records: MutationRecord[],
  selector: string,
  over: () => boolean,
  askFirst = false,
): { units: Element[]; cut: boolean; next: number } {
  const found = new Set<Element>();
  let cut = false;
  let next = records.length;
  try {
    for (let k = 0; k < records.length; k++) {
      if ((k > 0 || askFirst) && over()) {
        cut = true;
        next = k;
        break;
      }
      const r = records[k]!;
      if (r.type !== 'childList') continue;
      const added = r.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (!n || n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.hasAttribute(PLACEHOLDER_ATTR) || !el.isConnected) continue;
        if (el.matches(selector)) found.add(el);
        const inner = el.querySelectorAll(selector);
        for (let j = 0; j < inner.length; j++) {
          const m = inner[j]!;
          if (!m.hasAttribute(PLACEHOLDER_ATTR)) found.add(m);
        }
      }
    }
  } catch {
    return { units: [], cut: false, next: records.length };
  }
  const units: Element[] = [];
  for (const u of found) if (!hasInnerUnit(u, selector)) units.push(u);
  return { units, cut, next };
}

/** Elements a selector matches: the whole page when `full`, else around what changed. */
function collectMatches(root: Element, selector: string, full: boolean, touched: Set<Node>, added: Set<Element>): Element[] {
  try {
    if (full) return Array.from(root.querySelectorAll(selector));
    const out = new Set<Element>();
    for (const n of touched) {
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      const b = el?.isConnected ? el.closest(selector) : null;
      if (b) out.add(b);
    }
    for (const el of added) {
      if (!el.isConnected) continue;
      const b = el.closest(selector);
      if (b) out.add(b);
      const inner = el.querySelectorAll(selector);
      for (let i = 0; i < inner.length; i++) out.add(inner[i]!);
    }
    return [...out];
  } catch {
    return [];
  }
}

/**
 * Some sites wrap ads in a container that holds nothing else (Google's #tads,
 * #bottomads, [data-dsktp-pla]), often with a "Sponsored" header of its own.
 * Hiding only the ads inside would leave that header behind, so a unit inside
 * such a container is replaced by the outermost one.
 */
function collapseToContainers(units: Iterable<Element>, containerSelector: string): Element[] {
  const out = new Set<Element>();
  for (const u of units) {
    let top = u;
    for (let c = u.closest(containerSelector); c; c = c.parentElement?.closest(containerSelector) ?? null) top = c;
    out.add(top);
  }
  return [...out];
}

/** Fallback identity for units whose text lives in a shadow root. */
function structuralKey(unit: Element): string {
  const attrs = Array.from(unit.attributes)
    .filter((a) => a.name === 'id' || a.name.startsWith('data-') || a.name.endsWith('-id'))
    .map((a) => `${a.name}=${a.value}`)
    .join('&');
  return `${unit.tagName}?${attrs}`;
}
