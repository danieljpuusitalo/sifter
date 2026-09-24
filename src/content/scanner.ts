import { findGenericUnits, innermost } from '../adapters/generic';
import type { Adapter } from '../adapters/schema';
import { detectMarker, unitText } from '../extract';
import { fingerprint } from '../fingerprint';
import type { PageState, SiteContext } from '../messages';
import { decideTier0 } from '../rules/tier0';
import type { HideCategory, OverrideAction } from '../types';
import { Hider, PLACEHOLDER_ATTR } from './hider';

// Content-script pipeline: extract -> fingerprint -> tier 0 -> apply
// (BRIEF.md §5). Tier 1 (model) plugs in at the "unknown" branch in M2.

const DEBOUNCE_MS = 250; // hard rule 7
const SLICE_BUDGET_MS = 8; // hard rule 7: main-thread work per batch

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
  /** Test hook: run slices synchronously instead of via setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
};

type Seen = { sig: string; fp: string };

export class Scanner {
  private hider: Hider;
  private seen = new WeakMap<Element, Seen>();
  private userShown = new WeakSet<Element>();
  private hiddenFps = new Map<string, HideCategory>();
  private unitsSeen = new Set<string>();
  private observer: MutationObserver | null = null;
  private debounceTimer: unknown = null;
  private pending: Element[] = [];
  private running = false;
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
    this.observer = new MutationObserver((records) => {
      if (records.every(isOwnMutation)) return;
      this.requestScan();
    });
    this.observer.observe(target, { childList: true, subtree: true });
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
    };
  }

  requestScan(): void {
    if (this.debounceTimer !== null) return;
    this.debounceTimer = this.schedule(() => {
      this.debounceTimer = null;
      this.scanNow();
    }, DEBOUNCE_MS);
  }

  /** Collect units and process them in time slices of at most ~8 ms each. */
  scanNow(): void {
    this.hider.prune();
    if (!this.active) return;
    const units = this.collectUnits();
    const queued = new Set(this.pending);
    for (const u of units) if (!queued.has(u)) this.pending.push(u);
    if (!this.running) this.runSlice();
  }

  private collectUnits(): Element[] {
    const root = this.deps.doc.body;
    if (!root) return [];
    const { adapter } = this.deps;
    if (!adapter) return findGenericUnits(root);
    try {
      return innermost(root.querySelectorAll(adapter.unitSelector));
    } catch {
      return [];
    }
  }

  private runSlice(): void {
    this.running = true;
    const start = this.now();
    let processed = 0;
    while (this.pending.length > 0) {
      const unit = this.pending.shift();
      if (unit) this.processUnit(unit);
      processed++;
      if (this.now() - start >= SLICE_BUDGET_MS) break;
    }
    const took = this.now() - start;
    if (this.deps.dev && took > SLICE_BUDGET_MS * 1.5) {
      console.warn(`[sift] slice took ${took.toFixed(1)} ms for ${processed} units`);
    }
    if (this.pending.length > 0) {
      this.schedule(() => this.runSlice(), 0);
    } else {
      this.running = false;
    }
  }

  private processUnit(unit: Element): void {
    if (!unit.isConnected) return;
    const { adapter, hostname, baseUrl } = this.deps;
    // Cheap change signal (no layout): sites recycle feed nodes for new content.
    const raw = unit.textContent ?? '';
    const sig = `${raw.length}:${raw.slice(0, 80)}:${raw.slice(-40)}`;
    const prev = this.seen.get(unit);
    if (prev && prev.sig === sig) return;
    // "Show" sticks to the element for the page session even if its text changes
    // (like counts tick). A recycled node may then miss an ad: rule 6's trade.

    const marker = detectMarker(unit, adapter, baseUrl);
    const text = unitText(unit, adapter);
    // Skeleton units have no text yet; come back when they fill in, unless a
    // structural marker already settles it.
    if (!text && !marker) return;
    const fp = fingerprint(hostname, text || structuralKey(unit));
    this.seen.set(unit, { sig, fp });
    this.unitsSeen.add(fp);

    if (this.userShown.has(unit)) return;
    const decision = decideTier0({ override: this.ctx.overrides[fp], marker });
    if (decision.action === 'hide') {
      this.hider.hide(unit, decision.category);
      this.hiddenFps.set(fp, decision.category);
    } else if (this.hider.isHidden(unit)) {
      this.hider.unhide(unit);
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
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.hasAttribute(PLACEHOLDER_ATTR));
}

/** Fallback identity for units whose text lives in a shadow root. */
function structuralKey(unit: Element): string {
  const attrs = Array.from(unit.attributes)
    .filter((a) => a.name === 'id' || a.name.startsWith('data-') || a.name.endsWith('-id'))
    .map((a) => `${a.name}=${a.value}`)
    .join('&');
  return `${unit.tagName}?${attrs}`;
}
