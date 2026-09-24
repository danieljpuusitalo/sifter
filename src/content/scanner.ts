import { findGenericUnits, innermost } from '../adapters/generic';
import type { Adapter } from '../adapters/schema';
import { detectMarker, unitText } from '../extract';
import { fingerprint } from '../fingerprint';
import type { PageState, ScanPerf, SiteContext } from '../messages';
import { mutedWordHit, mutedWordPattern } from '../rules/filters';
import { decideTier0 } from '../rules/tier0';
import type { BlockCategory, HideCategory, OverrideAction } from '../types';
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
/** A whole page module hidden by rule: an adapter block, or one of the user's element rules. */
type Block = { selector: string; category: BlockCategory; innermost?: boolean };
type Decision = { unit: Element; fp: string; hide: HideCategory | null; block?: boolean };

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
  private settleWaiters: (() => void)[] = [];
  /** Elements hidden because a block rule matched them, which may not be feed units at all. */
  private blockHidden = new WeakMap<Element, string>();
  // What changed since the last scan. `touched` nodes changed in place, so the
  // unit around them is dirty; `added` subtrees may also hold whole new units.
  private touched = new Set<Node>();
  private added = new Set<Element>();
  private needFull = true;
  private perf: Omit<ScanPerf, 'pending'> = { scans: 0, fullScans: 0, unitsExamined: 0, unitsDecided: 0, slices: 0, totalMs: 0, maxSliceMs: 0, slicesOverBudget: 0 };
  private ctx: SiteContext;
  /** Blocks in force for the current context, and one joined selector to find them with. */
  private blocks: Block[] = [];
  private blockSelector: string | null = null;
  private muted: RegExp | null = null;
  private offRules: ReadonlySet<string> = new Set();
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
    this.compileContext();
  }

  /** Derive what the context implies once, not per unit. */
  private compileContext(): void {
    const { categories, customSelectors, mutedWords } = this.ctx;
    // Older service workers answer without offRules while the extension updates.
    this.offRules = new Set(this.ctx.offRules ?? []);
    const blocks: Block[] = [];
    for (const b of this.deps.adapter?.blocks ?? []) {
      if (categories[b.category] && !(b.rule && this.offRules.has(b.rule))) blocks.push(b);
    }
    if (categories.custom) {
      for (const selector of customSelectors) {
        // The options page validates rules, but storage is data: re-check before use (hard rule 2).
        try {
          this.deps.doc.querySelector(selector);
          blocks.push({ selector, category: 'custom' });
        } catch {
          /* invalid selector: skip it */
        }
      }
    }
    this.blocks = blocks;
    this.blockSelector = blocks.length ? blocks.map((b) => b.selector).join(', ') : null;
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
    this.hider.unhideAll();
  }

  /** New settings from the popup or options: re-decide everything on the page. */
  applyContext(ctx: SiteContext): void {
    this.ctx = ctx;
    this.compileContext();
    this.hider.setMode(ctx.hideMode);
    this.seen = new WeakMap();
    if (!this.active) {
      // Drop queued work too: a slice already scheduled must not hide anything now.
      this.pending = [];
      this.queued.clear();
      this.hiddenFps.clear();
      this.hider.unhideAll();
      this.markFull();
      return;
    }
    // Hidden elements a full scan may no longer collect (a block whose category or
    // rule was just switched off) still need a fresh decision, to be shown again.
    for (const u of this.hider.hiddenUnits()) this.enqueue(u);
    this.scanNow();
  }

  /** Resolves once queued work is done, so a caller reading state() sees the result. */
  settled(): Promise<void> {
    if (!this.running && this.debounceTimer === null) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  private enqueue(u: Element): void {
    if (this.queued.has(u)) return;
    this.queued.add(u);
    this.pending.push(u);
  }

  /** A user override changed: re-decide the whole page, so copies of the same post follow it. */
  private redecideAll(): void {
    this.seen = new WeakMap();
    for (const u of this.hider.hiddenUnits()) this.enqueue(u);
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
      this.hider.hide(el, 'manual');
      this.redecideAll();
      return true;
    }
    return false;
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
      categories: this.ctx.categories,
      canSuggest: !!this.deps.adapter?.suggested || !!this.deps.adapter?.blocks.some((b) => b.category === 'suggested'),
      rules: (this.deps.adapter?.suggested?.rules ?? []).map((r) => ({ id: r.id, label: r.label, on: !this.offRules.has(r.id) })),
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
      // Our own placeholder can match a unit selector (X's cells are bare divs).
      if (!u.hasAttribute(PLACEHOLDER_ATTR)) this.enqueue(u);
    }
    this.perf.totalMs += this.now() - start;
    if (!this.running && this.pending.length > 0) {
      this.running = true;
      this.idle((budget) => this.runSlice(budget));
    } else if (!this.running) {
      this.settle();
    }
  }

  private settle(): void {
    if (this.debounceTimer !== null) return;
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
    const blocks = this.blockSelector ? this.innermostBlocks(collectBlocks(root, this.blockSelector, full, touched, added), root) : [];
    if (!adapter) return [...this.collectGeneric(root, full, touched, added), ...blocks];
    try {
      const units = full
        ? innermost(root.querySelectorAll(adapter.unitSelector))
        : dirtyUnits(adapter.unitSelector, touched, added);
      const out = adapter.adContainerSelector ? collapseToContainers(units, adapter.adContainerSelector) : [...units];
      return blocks.length ? [...out, ...blocks] : out;
    } catch {
      return blocks;
    }
  }

  /** Drop ancestors an `innermost` block rule matched only because the module is inside them. */
  private innermostBlocks(found: Element[], root: Element): Element[] {
    if (!this.blocks.some((b) => b.innermost)) return found;
    // Compare against every match in the document, not el.querySelector(): a rule
    // that starts outside el ("[role=complementary] div:has(…)") is not reliably
    // found by a query scoped to el, and a false "no descendant" hides the column.
    const all = new Map<Block, Element[]>();
    return found.filter((el) => {
      const b = this.blockOf(el);
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

  /** The block rule an element was collected for, if any. */
  private blockOf(el: Element): Block | null {
    if (!this.blockSelector) return null;
    for (const b of this.blocks) {
      try {
        if (el.matches(b.selector)) return b;
      } catch {
        /* skip */
      }
    }
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
    if (!this.active) {
      this.pending = [];
      this.queued.clear();
      this.running = false;
      this.settle();
      return;
    }
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
      this.settle();
    }
  }

  /** DOM reads only. Returns null when nothing about the unit needs to change. */
  private decide(unit: Element): Decision | null {
    this.perf.unitsExamined++;
    if (!unit.isConnected) return null;
    const { adapter, baseUrl } = this.deps;
    // Fingerprints use the site key, so twitter.com and x.com share one identity.
    const site = this.ctx.siteKey;
    // Cheap change signal (no layout): sites recycle feed nodes for new content.
    const raw = unit.textContent ?? '';
    const sig = `${raw.length}:${raw.slice(0, 80)}:${raw.slice(-40)}`;
    const prev = this.seen.get(unit);
    if (prev && prev.sig === sig) return null;
    // "Show" sticks to the element for the page session even if its text changes
    // (like counts tick). A recycled node may then miss an ad: rule 6's trade.

    this.perf.unitsDecided++;
    const { categories } = this.ctx;
    const block = this.blockOf(unit);
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
      if (decision.action === 'hide') return { unit, fp, hide: decision.category, block: true };
      return this.hider.isHidden(unit) ? { unit, fp, hide: null } : null;
    }
    if (this.blockHidden.has(unit) && !this.isUnit(unit)) {
      // Its rule or category was switched off, and it isn't a post in its own right.
      return { unit, fp: this.blockHidden.get(unit) as string, hide: null };
    }
    const marker = detectMarker(unit, adapter, baseUrl, { suggested: categories.suggested, offRules: this.offRules });
    const text = unitText(unit, adapter);
    // Skeleton units have no text yet; come back when they fill in, unless a
    // structural marker already settles it.
    if (!text && !marker) return null;
    const fp = fingerprint(site, text || structuralKey(unit));
    this.seen.set(unit, { sig, fp });
    this.unitsSeen.add(fp);

    if (this.userShown.has(unit)) return null;
    const decision = decideTier0({
      override: this.ctx.overrides[fp],
      marker,
      custom: mutedWordHit(text, this.muted),
      categories,
    });
    if (decision.action === 'hide') return { unit, fp, hide: decision.category };
    return this.hider.isHidden(unit) ? { unit, fp, hide: null } : null;
  }

  /** DOM writes only. */
  private apply(d: Decision): void {
    if (!d.unit.isConnected || this.userShown.has(d.unit)) return;
    if (d.hide) {
      this.hider.hide(d.unit, d.hide);
      this.hiddenFps.set(d.fp, d.hide);
      if (d.block) this.blockHidden.set(d.unit, d.fp);
      else this.blockHidden.delete(d.unit);
    } else {
      this.hider.unhide(d.unit);
      this.hiddenFps.delete(d.fp);
      this.blockHidden.delete(d.unit);
    }
  }

  /** Whether the adapter (or the generic finder) would collect this element as a post. */
  private isUnit(el: Element): boolean {
    const { adapter } = this.deps;
    if (!adapter) return findGenericUnits(this.deps.doc.body ?? el).includes(el);
    try {
      return el.matches(adapter.unitSelector) || (!!adapter.adContainerSelector && el.matches(adapter.adContainerSelector));
    } catch {
      return false;
    }
  }

  private userShow(unit: Element): void {
    this.userShown.add(unit);
    const fp = this.seen.get(unit)?.fp;
    if (fp) this.hiddenFps.delete(fp);
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
    if (fp) this.redecideAll();
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

/** Page modules matched by a block selector, found the same dirty-only way as units. */
function collectBlocks(root: Element, selector: string, full: boolean, touched: Set<Node>, added: Set<Element>): Element[] {
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
