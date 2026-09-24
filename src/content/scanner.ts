import { findGenericUnits, innermost } from '../adapters/generic';
import type { Adapter } from '../adapters/schema';
import { detectMarker, unitText } from '../extract';
import { fingerprint } from '../fingerprint';
import type { PageState, ScanPerf, SiteContext } from '../messages';
import { decideTier0 } from '../rules/tier0';
import type { HideCategory, OverrideAction } from '../types';
import { Hider, PLACEHOLDER_ATTR } from './hider';

// Content-script pipeline: extract -> fingerprint -> tier 0 -> apply
// (BRIEF.md §5). Tier 1 (model) plugs in at the "unknown" branch in M2.
//
// Scrolling must stay smooth (hard rule 7), so the scanner:
//  - looks only at units a mutation touched, never re-walks the whole feed
//    (the old full rescan grew with the page: 600 cards meant 600 checks per scan);
//  - does its work in idle callbacks, after a frame is painted, in slices of at
//    most 8 ms;
//  - decides a slice with DOM reads only, then applies its hides in one write pass,
//    so a hide never forces the next unit's read to lay the page out again.
// `pnpm bench:scroll` measures frames with the extension off and on.

const DEBOUNCE_MS = 250; // hard rule 7
/** The generic extractor re-derives units from the whole page, so it runs less often. */
const GENERIC_DEBOUNCE_MS = 1000;
const SLICE_BUDGET_MS = 8; // hard rule 7: main-thread work per batch
/** An idle callback that fired on its timeout got no idle time: take a small bite. */
const STARVED_BUDGET_MS = 3;
const IDLE_TIMEOUT_MS = 200;
/** Past this many dirty nodes, one full collection is cheaper than mapping each. */
const MAX_DIRTY = 1500;

export type ScannerDeps = {
  doc: Document;
  hostname: string;
  baseUrl: string;
  adapter: Adapter | null;
  context: SiteContext;
  persistOverride: (fp: string, action: OverrideAction | null) => void;
  now?: () => number;
  /** Dev builds log batches that exceed the time budget. */
  dev?: boolean;
  /** Test hook: run the debounce and slices through this instead of timers and idle callbacks. */
  schedule?: (fn: () => void, ms: number) => unknown;
};

type Seen = { sig: string; fp: string };
type Decision = { unit: Element; fp: string; hide: HideCategory | null };

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
  private running = false;
  // What changed since the last scan. `touched` nodes changed in place, so the
  // unit around them is dirty; `added` subtrees may also hold whole new units.
  private touched = new Set<Node>();
  private added = new Set<Element>();
  private needFull = true;
  private perf: Omit<ScanPerf, 'pending'> = { scans: 0, fullScans: 0, unitsExamined: 0, unitsDecided: 0, slices: 0, totalMs: 0, maxSliceMs: 0, slicesOverBudget: 0 };
  private ctx: SiteContext;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;

  constructor(private deps: ScannerDeps) {
    this.ctx = deps.context;
    this.now = deps.now ?? (() => performance.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.hider = new Hider(deps.doc, deps.context.hideMode, {
      onShow: (unit) => this.userShow(unit),
      onNotAd: (unit) => this.userNotAd(unit),
    });
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
    this.hider.unhideAll();
  }

  /** New settings from the popup or options: re-decide everything on the page. */
  applyContext(ctx: SiteContext): void {
    this.ctx = ctx;
    this.hider.setMode(ctx.hideMode);
    this.seen = new WeakMap();
    if (!this.active) {
      this.hider.unhideAll();
      this.markFull();
      return;
    }
    this.scanNow();
  }

  showAll(): void {
    for (const u of this.hider.hiddenUnits()) this.userShow(u);
  }

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
      hiddenNow: this.hider.hiddenUnits().length,
      perf: { ...this.perf, pending: this.pending.length },
    };
  }

  /** Runs on every mutation batch, often mid-scroll: bookkeeping only, no DOM reads. */
  private onMutations(records: MutationRecord[]): void {
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
    if (relevant) this.requestScan();
  }

  private markFull(): void {
    this.needFull = true;
    this.touched.clear();
    this.added.clear();
  }

  requestScan(): void {
    if (this.debounceTimer !== null) return;
    this.debounceTimer = this.schedule(
      () => {
        this.debounceTimer = null;
        this.scanNow(false);
      },
      this.deps.adapter ? DEBOUNCE_MS : GENERIC_DEBOUNCE_MS,
    );
  }

  /**
   * Queue units, then work through them in idle-time slices of at most ~8 ms.
   * `full` re-collects the whole page (start, settings change); otherwise only
   * units touched by mutations since the last scan are looked at.
   */
  scanNow(full = true): void {
    const start = this.now();
    this.hider.prune();
    if (!this.active) {
      this.markFull();
      return;
    }
    this.perf.scans++;
    if (full) this.markFull();
    for (const u of this.collectUnits()) {
      if (this.queued.has(u)) continue;
      this.queued.add(u);
      this.pending.push(u);
    }
    this.perf.totalMs += this.now() - start;
    if (!this.running && this.pending.length > 0) {
      this.running = true;
      this.idle((budget) => this.runSlice(budget));
    }
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
    if (!adapter) return this.collectGeneric(root, full, touched, added);
    try {
      const units = full
        ? innermost(root.querySelectorAll(adapter.unitSelector))
        : dirtyUnits(adapter.unitSelector, touched, added);
      return adapter.adContainerSelector ? collapseToContainers(units, adapter.adContainerSelector) : [...units];
    } catch {
      return [];
    }
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

  /** Runs `fn` in idle time, after the current frame is painted, so it never delays one. */
  private idle(fn: (budget: number) => void): void {
    if (this.deps.schedule) {
      this.deps.schedule(() => fn(SLICE_BUDGET_MS), 0);
      return;
    }
    const view = this.deps.doc.defaultView;
    if (view && typeof view.requestIdleCallback === 'function') {
      view.requestIdleCallback(
        (d) => fn(d.didTimeout ? STARVED_BUDGET_MS : Math.min(SLICE_BUDGET_MS, Math.max(1, d.timeRemaining()))),
        { timeout: IDLE_TIMEOUT_MS },
      );
    } else {
      setTimeout(() => fn(SLICE_BUDGET_MS), 0);
    }
  }

  /**
   * One slice: decide units while the budget lasts (DOM reads only), then apply
   * the hides in one pass (DOM writes only). Interleaving the two would make each
   * read after a hide lay the page out again.
   */
  private runSlice(budget: number): void {
    const start = this.now();
    const decisions: Decision[] = [];
    let i = 0;
    while (i < this.pending.length) {
      const unit = this.pending[i++] as Element;
      this.queued.delete(unit);
      const d = this.decide(unit);
      if (d) decisions.push(d);
      if (this.now() - start >= budget) break;
    }
    this.pending = i >= this.pending.length ? [] : this.pending.slice(i);
    for (const d of decisions) this.apply(d);
    const took = this.now() - start;
    this.perf.slices++;
    this.perf.totalMs += took;
    this.perf.maxSliceMs = Math.max(this.perf.maxSliceMs, took);
    if (took > SLICE_BUDGET_MS * 1.5) this.perf.slicesOverBudget++;
    if (this.deps.dev && took > SLICE_BUDGET_MS * 1.5) {
      console.warn(`[sifter] slice took ${took.toFixed(1)} ms for ${i} units`);
    }
    if (this.pending.length > 0) {
      this.idle((b) => this.runSlice(b));
    } else {
      this.running = false;
    }
  }

  /** DOM reads only. Returns null when nothing about the unit needs to change. */
  private decide(unit: Element): Decision | null {
    this.perf.unitsExamined++;
    if (!unit.isConnected) return null;
    const { adapter, hostname, baseUrl } = this.deps;
    // Cheap change signal (no layout): sites recycle feed nodes for new content.
    const raw = unit.textContent ?? '';
    const sig = `${raw.length}:${raw.slice(0, 80)}:${raw.slice(-40)}`;
    const prev = this.seen.get(unit);
    if (prev && prev.sig === sig) return null;
    // "Show" sticks to the element for the page session even if its text changes
    // (like counts tick). A recycled node may then miss an ad: rule 6's trade.

    this.perf.unitsDecided++;
    const marker = detectMarker(unit, adapter, baseUrl);
    const text = unitText(unit, adapter);
    // Skeleton units have no text yet; come back when they fill in, unless a
    // structural marker already settles it.
    if (!text && !marker) return null;
    const fp = fingerprint(hostname, text || structuralKey(unit));
    this.seen.set(unit, { sig, fp });
    this.unitsSeen.add(fp);

    if (this.userShown.has(unit)) return null;
    const decision = decideTier0({ override: this.ctx.overrides[fp], marker });
    if (decision.action === 'hide') return { unit, fp, hide: decision.category };
    return this.hider.isHidden(unit) ? { unit, fp, hide: null } : null;
  }

  /** DOM writes only. */
  private apply(d: Decision): void {
    if (!d.unit.isConnected || this.userShown.has(d.unit)) return;
    if (d.hide) {
      this.hider.hide(d.unit, d.hide);
      this.hiddenFps.set(d.fp, d.hide);
    } else {
      this.hider.unhide(d.unit);
    }
  }

  private userShow(unit: Element): void {
    this.userShown.add(unit);
    this.hider.unhide(unit);
  }

  private userNotAd(unit: Element): void {
    const fp = this.seen.get(unit)?.fp;
    if (fp) {
      this.ctx = { ...this.ctx, overrides: { ...this.ctx.overrides, [fp]: 'not-ad' } };
      this.hiddenFps.delete(fp);
      this.deps.persistOverride(fp, 'not-ad');
    }
    this.userShow(unit);
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

/**
 * The innermost units that contain a changed node or sit inside an added
 * subtree: the same answer innermost() gives over the whole page, restricted to
 * what changed. A unit is innermost exactly when it holds no other unit.
 */
function dirtyUnits(selector: string, touched: Set<Node>, added: Set<Element>): Set<Element> {
  const out = new Set<Element>();
  const consider = (u: Element | null | undefined) => {
    if (u && u.isConnected && !out.has(u) && !u.querySelector(selector)) out.add(u);
  };
  for (const n of touched) {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (el?.isConnected) consider(el.closest(selector));
  }
  for (const el of added) {
    if (!el.isConnected) continue;
    consider(el.closest(selector));
    const inner = el.querySelectorAll(selector);
    for (let i = 0; i < inner.length; i++) consider(inner[i]);
  }
  return out;
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
