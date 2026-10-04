// Hide timing and flips, for dev builds and the live bench only (SIFTER_TRACE=1).
//
// Two questions the scanner's counters can't answer (live report 2026-10-01):
//
// - How long a post stays visible before its hide lands, and why. A hide that lands
//   on screen either had its content arrive while the post was already on screen
//   (ordering the queue cannot help), or arrived off screen and scrolled in while it
//   waited in the queue (giving near-viewport units priority would).
// - Which rule hides a post and then lets it go again on its own: a "flip". The user
//   sees a post hidden, then back, or a Show bar that vanishes.
//
// Nothing here records page text: a flip keeps the rule id, the marker kind, and the
// marker detail only where that is the adapter's own selector or an ad host. Label
// details are the site's text ("<Name> likes this") and are dropped. Zones come from
// an IntersectionObserver: no forced layout, even in a dev build.
//
// And, for scroll stability (Phase 0 of the LinkedIn plan): every write that changes a
// unit's height, by path and the unit's zone a frame later; every `keepInPlace` scroll;
// re-mounts (a born unit whose `componentkey` an earlier element carried) and whether
// they came back at another height; hides whose class the site wiped; and the cost of
// the work the scanner's counters do not time. Keys never leave this file.

import { COLLAPSE_CLASS, HIDDEN_CLASS, TAG_CLASS } from './hider';
import { zoneOf } from './viewport';

export type LatencySummary = { n: number; p50: number; p90: number; max: number };

export type Flip = {
  /** performance.now() when it happened. */
  at: number;
  /**
   * `redecided`: a rescan of the same element no longer hides it. `emptied`: the
   * element lost its content. `replaced`: a post the user had shown left the page
   * (the site swapped the element), taking its Hide bar with it.
   */
  what: 'redecided' | 'emptied' | 'replaced';
  /** The user had pressed Show on it. */
  userShown: boolean;
  /** How long the hide had held, in ms. */
  heldMs: number;
  category: string;
  rule?: string;
  kind?: string;
  detail?: string;
};

/**
 * Where the time went for the hides the reader saw land (on screen at the hide). Each
 * hide's time splits at the collect: `waitMs` is the mutation to the scan that
 * collected it (debounce and idle wait), `queueMs` the collect to the hide (the
 * queue and the decide). `requeued` counts hides whose unit had been queued before
 * and decided "no hide": the site supplied the signal late. `sinceFirstMs` runs from
 * the first time the unit was queued at all.
 */
export type OnScreenStages = {
  n: number;
  requeued: number;
  waitMs: LatencySummary;
  /** `waitMs`, split at the debounce timer firing: before it, and the idle wait after. */
  debounceMs: LatencySummary;
  idleMs: LatencySummary;
  queueMs: LatencySummary;
  sinceFirstMs: LatencySummary;
  /** The queue's length when the unit joined it. */
  depth: LatencySummary;
};

/**
 * How a unit the debounced pass hid reached the page, which says which lever would
 * have caught it before paint. `filled`: first seen as an empty shell (born bare in
 * the lane, or decided empty), its content came later. `overflow`: born whole, cut
 * by the lane's budget. `abstain`: born whole, the lane left it to decide().
 * `labelLate`: decided "no hide" before, the signal came later. `slow`: none of
 * these, the label was there and the decision was late.
 */
export type Arrival = 'filled' | 'overflow' | 'abstain' | 'labelLate' | 'slow';
export const ARRIVALS: readonly Arrival[] = ['filled', 'overflow', 'abstain', 'labelLate', 'slow'];
export type ArrivalCount = { onScreen: number; offScreen: number };

/**
 * Where a write that may change a unit's height came from (scroll-stability Phase 0).
 * `lane`: the pre-paint lane. `decide`: the debounced pass (a tag, unless the page was
 * still loading). `user`: a pass the user started (settings, pause, Show all).
 * `farBelow` / `tagCollapsed` / `rail`: the viewport tracker settling a tag at its first
 * look, later, or in a pinned rail. `release` / `laneRelease`: a hide let go by a
 * decision. `click`: a placeholder button or the context menu. `mode`: the hide mode changed.
 */
export type WritePath = 'lane' | 'decide' | 'user' | 'farBelow' | 'tagCollapsed' | 'rail' | 'release' | 'laneRelease' | 'click' | 'mode';
export const WRITE_PATHS: readonly WritePath[] = ['lane', 'decide', 'user', 'farBelow', 'tagCollapsed', 'rail', 'release', 'laneRelease', 'click', 'mode'];
/** The unit's zone one frame after the write, from an IntersectionObserver (no forced layout). `gone`: it left the page first. */
export type WriteZone = 'in' | 'above' | 'below' | 'gone';
const WRITE_ZONES: readonly WriteZone[] = ['in', 'above', 'below', 'gone'];
/** Main-thread work the scanner's counters did not time. `mutations`: onMutations outside the lane. */
export type CostKind = 'mutations' | 'flush' | 'io' | 'markContents';
export const COST_KINDS: readonly CostKind[] = ['mutations', 'flush', 'io', 'markContents'];
export type CostSummary = { n: number; totalMs: number; p99: number; max: number };

/** One attributed event, for matching against the bench's frame probe by time. No keys, no text. */
export type TraceEvent =
  | { at: number; kind: 'write'; path: WritePath; collapsed: boolean }
  | { at: number; kind: 'scroll'; delta: number; whileScrolling: boolean };

export type AttributionStats = {
  /** Writes that changed a unit's height (collapsed <-> full), by path and the unit's zone a frame later. */
  heightWrites: Record<WritePath, Record<WriteZone, number>>;
  /** Writes that left the height as it was (a tag, blur mode, a hide already in place), by path. */
  neutralWrites: Record<WritePath, number>;
  /** `keepInPlace` corrections: count, total |px|, and those within 150 ms of a scroll event. */
  scrolls: { n: number; px: number; whileScrolling: number };
  /** Born units whose key (`componentkey`) an earlier, different element carried: a re-mount. */
  remounts: number;
  /** The same element added again (moved, or detached and re-attached). */
  reattached: number;
  /** Born units with no key to recognise a re-mount by. */
  unkeyed: number;
  /** Re-mounts painted at another height state than their key last had: the flip the reader sees. */
  remountFlips: { toCollapsed: number; toFull: number };
  /** Tracked, unshown hides whose `sifter-hidden` / `sifter-tag` class went missing (the site rewrote `class`). */
  classesVanished: number;
  cost: Record<CostKind, CostSummary>;
  /** Newest last, capped at `MAX_EVENTS`. */
  events: TraceEvent[];
  eventCount: number;
};

export type TraceStats = {
  /** Scroll-stability attribution: height writes, scroll corrections, re-mounts, costs. */
  attribution: AttributionStats;
  /** Debounced-pass hides by arrival class, split by where the unit was at the hide. */
  arrival: Record<Arrival, ArrivalCount>;
  /** Content to hide, in ms, by where the unit was when queued and when hidden. */
  latency: {
    /** On screen when its content arrived, and still when hidden. */
    alreadyOnScreen: LatencySummary;
    /** Off screen when queued, on screen by the time it was hidden. */
    enteredWhileQueued: LatencySummary;
    /** Off screen when hidden: the reader never saw it. */
    offScreen: LatencySummary;
  };
  onScreen: OnScreenStages;
  /** Newest last, capped at `MAX_FLIPS`. */
  flips: Flip[];
  flipCount: number;
  /** Hidden elements that left the page (virtualised feeds do this all the time). */
  hiddenLeft: number;
};

/** Why a unit is hidden, without page text. */
export type HideWhy = { category: string; rule?: string; kind?: string; detail?: string };

export interface HideTrace {
  /** A mutation or a scan request: units collected next got their content no later than this. */
  dirty(now: number): void;
  /** The debounce fired: the batch asked for its scan, and now waits for an idle slice. */
  due(now: number): void;
  /** The scan is collecting: returns the moment the batch went dirty, and starts a new batch. */
  takeDirty(now: number): number;
  /** A collected unit entered the queue at `now`, behind `depth` others. */
  queued(unit: Element, since: number, now?: number, depth?: number): void;
  /** A queued unit turned out empty: its content has not arrived yet. */
  empty(unit: Element): void;
  /** The lane saw this unit born with no content (an empty shell the site fills later). */
  bornBare(unit: Element): void;
  /** The lane met this born unit and left it to the debounced pass: over budget, or abstained. */
  laneSkipped(unit: Element, why: 'overflow' | 'abstain'): void;
  hid(unit: Element, now: number, why: HideWhy): void;
  /** A hide (or a Show) let go by a decision the user did not make. */
  released(unit: Element, now: number, what: 'redecided' | 'emptied', userShown: boolean): void;
  shown(unit: Element): void;
  unshown(unit: Element): void;
  /** After the hider prunes: hidden or shown elements that left the page. */
  sweep(now: number): void;
  /** The lane met this unit born: counts re-mounts, and a frame later whether it came back at its old height. */
  born(unit: Element): void;
  /** Sifter just wrote to this unit's presentation: counted by path if its height state changed. */
  wrote(unit: Element, path: WritePath, now: number): void;
  /** `keepInPlace` scrolled the page by `delta` px. */
  scrolled(delta: number, now: number): void;
  /** The hides Sifter tracks and has not shown: each must still carry its class. */
  classesKept(units: readonly Element[]): void;
  cost(kind: CostKind, ms: number): void;
  stats(): TraceStats;
  /** Bench hook: start a fresh window (the counters before were the page load). */
  reset(): void;
}

export const MAX_FLIPS = 50;
const MAX_SAMPLES = 5000;
export const MAX_EVENTS = 3000;
/** Keys remembered for re-mount checks; the oldest are dropped past this. */
const MAX_KEYS = 5000;
/** A correction this soon after a scroll event counts as made during a scroll. */
const SCROLLING_MS = 150;

type Height = 'collapsed' | 'full';

/** What a unit's own classes say about its height: collapsed (or display:none) by Sifter, or full. Reads no layout. */
export function heightState(unit: Element): Height {
  const c = unit.classList;
  if (!c.contains(HIDDEN_CLASS)) return 'full';
  return c.contains(COLLAPSE_CLASS) || (unit as HTMLElement).style?.getPropertyValue('display') === 'none' ? 'collapsed' : 'full';
}

/** The key a re-mounted unit would carry again, if the site gives one. Never leaves the trace. */
function unitKey(unit: Element): string | null {
  return unit.getAttribute('componentkey') ?? unit.getAttribute('data-urn') ?? null;
}

export type TracerOptions = {
  /** The next animation frame (the re-mount height check). Without it the check runs at once. */
  frame?: (fn: () => void) => void;
  /** Where scroll events arrive, so a correction can be told mid-scroll. */
  doc?: Document;
  now?: () => number;
};

type Pending = {
  since: number;
  dueAt: number;
  collectedAt: number;
  firstSince: number;
  times: number;
  depth: number;
  inViewAtQueue?: boolean;
  hiddenAt?: number;
};

function summary(xs: number[]): LatencySummary {
  if (!xs.length) return { n: 0, p50: 0, p90: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] as number);
  return { n: s.length, p50: at(0.5), p90: at(0.9), max: Math.round(s[s.length - 1] as number) };
}

/** Marker details that are the adapter's own vocabulary or an ad host, never the site's text. */
const SAFE_DETAIL_KINDS = new Set(['structural', 'block', 'ad-link', 'rel']);

export function safeDetail(kind: string | undefined, detail: string | undefined): string | undefined {
  return kind && SAFE_DETAIL_KINDS.has(kind) ? detail : undefined;
}

export class Tracer implements HideTrace {
  private dirtySince: number | null = null;
  private dueAt: number | null = null;
  private batchDue: number | null = null;
  // A WeakMap: a unit queued and never hidden is never recorded, and a Map kept every
  // such element (and its detached subtree) alive for the whole trace run.
  private readonly pending = new WeakMap<Element, Pending>();
  private readonly hidden = new Map<Element, HideWhy & { at: number }>();
  private readonly userShown = new Set<Element>();
  private lat = { alreadyOnScreen: [] as number[], enteredWhileQueued: [] as number[], offScreen: [] as number[] };
  private stages = Tracer.noStages();
  private flips: Flip[] = [];
  private flipCount = 0;
  private hiddenLeft = 0;
  private arrival = Tracer.noArrival();
  private shells = new WeakSet<Element>();
  private skipped = new WeakMap<Element, 'overflow' | 'abstain'>();
  private readonly io: IntersectionObserver | null;

  // Scroll-stability attribution.
  private heightWrites = Tracer.noWrites();
  private neutralWrites = Tracer.noPaths();
  private scrolls = { n: 0, px: 0, whileScrolling: 0 };
  private remounts = 0;
  private reattached = 0;
  private unkeyed = 0;
  private remountFlips = { toCollapsed: 0, toFull: 0 };
  private classesVanished = 0;
  private costs = Tracer.noCosts();
  private events: TraceEvent[] = [];
  private eventCount = 0;
  /** Each unit's height state as Sifter last left it. */
  private readonly lastHeight = new WeakMap<Element, Height>();
  /** Each key's height state, as its last element was painted or written. */
  private readonly keyHeight = new Map<string, { h: Height; id: number }>();
  private readonly ids = new WeakMap<Element, number>();
  /** The key's state under its previous element, for a unit written before `born` saw it. */
  private readonly priorOf = new WeakMap<Element, Height>();
  private nextId = 0;
  private readonly keyOf = new WeakMap<Element, string>();
  private readonly bornSeen = new WeakSet<Element>();
  private readonly vanished = new WeakSet<Element>();
  /** Height writes waiting for their zone, by path; a disconnected one is counted `gone` at the next sweep. */
  private readonly zoneWait = new Map<Element, WritePath[]>();
  /** Born units waiting for the next frame's height check. */
  private bornWait: { unit: Element; key: string; before: Height | undefined }[] = [];
  private readonly writeIO: IntersectionObserver | null;
  private readonly frame: (fn: () => void) => void;
  private readonly clock: () => number;
  private lastScrollAt = Number.NEGATIVE_INFINITY;

  constructor(IO: typeof IntersectionObserver | undefined, opts: TracerOptions = {}) {
    // Created first: tests reach the latency observer as the last one constructed.
    this.writeIO = IO ? new IO((entries) => this.onWriteEntries(entries)) : null;
    this.io = IO ? new IO((entries) => this.onEntries(entries)) : null;
    this.frame = opts.frame ?? ((fn) => fn());
    this.clock = opts.now ?? (() => performance.now());
    opts.doc?.addEventListener('scroll', () => (this.lastScrollAt = this.clock()), { capture: true, passive: true });
  }

  born(unit: Element): void {
    if (this.bornSeen.has(unit)) {
      this.reattached++;
      return;
    }
    this.bornSeen.add(unit);
    const key = unitKey(unit);
    if (key === null) {
      this.unkeyed++;
      return;
    }
    this.keyOf.set(unit, key);
    // The lane's own write to this element may already be remembered: only another element counts.
    const prev = this.keyHeight.get(key);
    const before = this.priorOf.get(unit) ?? (prev && prev.id !== this.idOf(unit) ? prev.h : undefined);
    if (before !== undefined) this.remounts++;
    // The lane writes in this same callback (or its one continuation): what the reader
    // sees is the state at the next frame. One frame callback per batch, not per unit.
    this.bornWait.push({ unit, key, before });
    if (this.bornWait.length === 1) this.frame(() => this.flushBorn());
  }

  private flushBorn(): void {
    const batch = this.bornWait;
    this.bornWait = [];
    for (const { unit, key, before } of batch) {
      if (!unit.isConnected) continue;
      const now = heightState(unit);
      if (before !== undefined && now !== before) {
        if (now === 'collapsed') this.remountFlips.toCollapsed++;
        else this.remountFlips.toFull++;
      }
      this.remember(key, unit, now);
    }
  }

  /** A number per element, so the key memory can tell elements apart without holding them. */
  private idOf(unit: Element): number {
    let id = this.ids.get(unit);
    if (id === undefined) {
      id = ++this.nextId;
      this.ids.set(unit, id);
    }
    return id;
  }

  wrote(unit: Element, path: WritePath, now: number): void {
    const after = heightState(unit);
    const before = this.lastHeight.get(unit) ?? 'full';
    this.lastHeight.set(unit, after);
    const key = this.keyOf.get(unit) ?? unitKey(unit);
    if (key !== null) this.remember(key, unit, after);
    if (after === before) {
      this.neutralWrites[path]++;
      return;
    }
    this.event({ at: now, kind: 'write', path, collapsed: after === 'collapsed' });
    if (!this.writeIO) {
      this.heightWrites[path].gone++;
      return;
    }
    const waiting = this.zoneWait.get(unit);
    if (waiting) waiting.push(path);
    else this.zoneWait.set(unit, [path]);
    // A fresh observation answers after the next layout, with the zone as painted.
    this.writeIO.unobserve(unit);
    this.writeIO.observe(unit);
  }

  scrolled(delta: number, now: number): void {
    const whileScrolling = now - this.lastScrollAt < SCROLLING_MS;
    this.scrolls.n++;
    this.scrolls.px += Math.abs(delta);
    if (whileScrolling) this.scrolls.whileScrolling++;
    this.event({ at: now, kind: 'scroll', delta: Math.round(delta), whileScrolling });
  }

  classesKept(units: readonly Element[]): void {
    for (const u of units) {
      if (!u.isConnected || this.vanished.has(u)) continue;
      const c = u.classList;
      if (c.contains(HIDDEN_CLASS) || c.contains(TAG_CLASS)) continue;
      this.vanished.add(u);
      this.classesVanished++;
    }
  }

  cost(kind: CostKind, ms: number): void {
    const c = this.costs[kind];
    c.n++;
    c.total += ms;
    if (ms > c.max) c.max = ms;
    if (c.samples.length < MAX_SAMPLES) c.samples.push(ms);
  }

  private remember(key: string, unit: Element, h: Height): void {
    const id = this.idOf(unit);
    const prev = this.keyHeight.get(key);
    // The lane writes a born unit before `born` sees it: keep what the key's last element had.
    if (prev && prev.id !== id && !this.priorOf.has(unit)) this.priorOf.set(unit, prev.h);
    this.keyHeight.delete(key);
    this.keyHeight.set(key, { h, id });
    if (this.keyHeight.size > MAX_KEYS) {
      const oldest = this.keyHeight.keys().next().value;
      if (oldest !== undefined) this.keyHeight.delete(oldest);
    }
  }

  private event(e: TraceEvent): void {
    this.eventCount++;
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private onWriteEntries(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const paths = this.zoneWait.get(e.target);
      this.writeIO?.unobserve(e.target);
      if (!paths) continue;
      this.zoneWait.delete(e.target);
      const zone = writeZone(e);
      for (const p of paths) this.heightWrites[p][zone]++;
    }
  }

  private attribution(): AttributionStats {
    const cost = Object.fromEntries(
      COST_KINDS.map((k) => {
        const c = this.costs[k];
        const s = [...c.samples].sort((a, b) => a - b);
        const p99 = s.length ? (s[Math.min(s.length - 1, Math.floor(0.99 * s.length))] as number) : 0;
        return [k, { n: c.n, totalMs: round2(c.total), p99: round2(p99), max: round2(c.max) }];
      }),
    ) as Record<CostKind, CostSummary>;
    return {
      heightWrites: Object.fromEntries(WRITE_PATHS.map((p) => [p, { ...this.heightWrites[p] }])) as Record<WritePath, Record<WriteZone, number>>,
      neutralWrites: { ...this.neutralWrites },
      scrolls: { ...this.scrolls, px: Math.round(this.scrolls.px) },
      remounts: this.remounts,
      reattached: this.reattached,
      unkeyed: this.unkeyed,
      remountFlips: { ...this.remountFlips },
      classesVanished: this.classesVanished,
      cost,
      events: [...this.events],
      eventCount: this.eventCount,
    };
  }

  dirty(now: number): void {
    if (this.dirtySince === null) this.dirtySince = now;
  }

  due(now: number): void {
    if (this.dueAt === null) this.dueAt = now;
  }

  takeDirty(now: number): number {
    const since = this.dirtySince ?? now;
    this.dirtySince = null;
    this.batchDue = this.dueAt;
    this.dueAt = null;
    return since;
  }

  /**
   * The latest batch that queued it counts, not the first: a post that was decided
   * "no hide" and later gains its signal (a social line filling in) was waiting on
   * the site, not on the scanner. Re-observing gives a fresh zone for that batch.
   */
  queued(unit: Element, since: number, now = since, depth = 0): void {
    if (this.hidden.has(unit)) return;
    const prev = this.pending.get(unit);
    // A full scan (start, settings) has no debounce: its idle wait starts at the request.
    const dueAt = Math.min(now, Math.max(since, this.batchDue ?? since));
    this.pending.set(unit, { since, dueAt, collectedAt: now, firstSince: prev?.firstSince ?? since, times: (prev?.times ?? 0) + 1, depth });
    if (!this.io) return;
    this.io.unobserve(unit);
    this.io.observe(unit);
  }

  empty(unit: Element): void {
    this.shells.add(unit);
    if (this.pending.delete(unit)) this.io?.unobserve(unit);
  }

  bornBare(unit: Element): void {
    this.shells.add(unit);
  }

  laneSkipped(unit: Element, why: 'overflow' | 'abstain'): void {
    this.skipped.set(unit, why);
  }

  hid(unit: Element, now: number, why: HideWhy): void {
    this.hidden.set(unit, { ...why, at: now });
    const p = this.pending.get(unit);
    if (!p) return;
    p.hiddenAt = now;
    if (!this.io) {
      this.pending.delete(unit);
      return;
    }
    // A fresh observation gives the zone at the hide. Without a queue-time answer yet
    // (hidden in the slice that queued it), it is still observed and the one answer
    // serves both.
    if (p.inViewAtQueue !== undefined) this.io.observe(unit);
  }

  released(unit: Element, now: number, what: 'redecided' | 'emptied', userShown: boolean): void {
    const h = this.hidden.get(unit);
    this.hidden.delete(unit);
    this.userShown.delete(unit);
    if (!h) return;
    this.flip({ at: now, what, userShown, heldMs: Math.round(now - h.at), category: h.category, rule: h.rule, kind: h.kind, detail: h.detail });
  }

  shown(unit: Element): void {
    if (this.hidden.has(unit)) this.userShown.add(unit);
  }

  unshown(unit: Element): void {
    this.userShown.delete(unit);
  }

  sweep(now: number): void {
    for (const [u, paths] of this.zoneWait) {
      if (u.isConnected) continue;
      this.zoneWait.delete(u);
      this.writeIO?.unobserve(u);
      for (const p of paths) this.heightWrites[p].gone++;
    }
    for (const [u, h] of this.hidden) {
      if (u.isConnected) continue;
      this.hidden.delete(u);
      if (this.userShown.delete(u)) {
        this.flip({ at: now, what: 'replaced', userShown: true, heldMs: Math.round(now - h.at), category: h.category, rule: h.rule, kind: h.kind, detail: h.detail });
      } else this.hiddenLeft++;
    }
  }

  stats(): TraceStats {
    return {
      attribution: this.attribution(),
      arrival: Object.fromEntries(ARRIVALS.map((a) => [a, { ...this.arrival[a] }])) as Record<Arrival, ArrivalCount>,
      latency: {
        alreadyOnScreen: summary(this.lat.alreadyOnScreen),
        enteredWhileQueued: summary(this.lat.enteredWhileQueued),
        offScreen: summary(this.lat.offScreen),
      },
      onScreen: {
        n: this.stages.wait.length,
        requeued: this.stages.requeued,
        waitMs: summary(this.stages.wait),
        debounceMs: summary(this.stages.debounce),
        idleMs: summary(this.stages.idle),
        queueMs: summary(this.stages.queue),
        sinceFirstMs: summary(this.stages.sinceFirst),
        depth: summary(this.stages.depth),
      },
      flips: [...this.flips],
      flipCount: this.flipCount,
      hiddenLeft: this.hiddenLeft,
    };
  }

  reset(): void {
    this.lat = { alreadyOnScreen: [], enteredWhileQueued: [], offScreen: [] };
    this.stages = Tracer.noStages();
    this.flips = [];
    this.flipCount = 0;
    this.hiddenLeft = 0;
    this.arrival = Tracer.noArrival();
    // The key memory stays: a post first seen during the page load can come back mid-window.
    this.heightWrites = Tracer.noWrites();
    this.neutralWrites = Tracer.noPaths();
    this.scrolls = { n: 0, px: 0, whileScrolling: 0 };
    this.remounts = 0;
    this.reattached = 0;
    this.unkeyed = 0;
    this.remountFlips = { toCollapsed: 0, toFull: 0 };
    this.classesVanished = 0;
    this.costs = Tracer.noCosts();
    this.events = [];
    this.eventCount = 0;
  }

  private flip(f: Flip): void {
    this.flipCount++;
    this.flips.push(f);
    if (this.flips.length > MAX_FLIPS) this.flips.shift();
  }

  private onEntries(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const p = this.pending.get(e.target);
      if (!p) continue;
      if (p.inViewAtQueue === undefined) p.inViewAtQueue = e.isIntersecting;
      this.io?.unobserve(e.target);
      // Not hidden (yet): `hid` observes it again for the zone at the hide. Watching
      // every queued post for its whole life would bill the trace's callbacks to Sifter.
      if (p.hiddenAt === undefined) continue;
      this.record(e.target, p, e.isIntersecting);
      this.pending.delete(e.target);
    }
  }

  private arrivalOf(unit: Element, p: Pending): Arrival {
    if (this.shells.has(unit)) return 'filled';
    const skipped = this.skipped.get(unit);
    if (skipped) return skipped;
    return p.times > 1 ? 'labelLate' : 'slow';
  }

  /** Called with the zone at the hide. A unit queued and never hidden leaves with its element (a WeakMap). */
  private record(unit: Element, p: Pending, inViewAtHide: boolean): void {
    const at = p.hiddenAt as number;
    const a = this.arrival[this.arrivalOf(unit, p)];
    if (inViewAtHide) a.onScreen++;
    else a.offScreen++;
    const bucket = !inViewAtHide ? this.lat.offScreen : p.inViewAtQueue ? this.lat.alreadyOnScreen : this.lat.enteredWhileQueued;
    if (bucket.length < MAX_SAMPLES) bucket.push(at - p.since);
    const s = this.stages;
    if (!inViewAtHide || s.wait.length >= MAX_SAMPLES) return;
    s.wait.push(p.collectedAt - p.since);
    s.debounce.push(p.dueAt - p.since);
    s.idle.push(p.collectedAt - p.dueAt);
    s.queue.push(at - p.collectedAt);
    s.sinceFirst.push(at - p.firstSince);
    s.depth.push(p.depth);
    if (p.times > 1) s.requeued++;
  }

  private static noArrival(): Record<Arrival, ArrivalCount> {
    return Object.fromEntries(ARRIVALS.map((a) => [a, { onScreen: 0, offScreen: 0 }])) as Record<Arrival, ArrivalCount>;
  }

  private static noPaths(): Record<WritePath, number> {
    return Object.fromEntries(WRITE_PATHS.map((p) => [p, 0])) as Record<WritePath, number>;
  }

  private static noWrites(): Record<WritePath, Record<WriteZone, number>> {
    return Object.fromEntries(WRITE_PATHS.map((p) => [p, Object.fromEntries(WRITE_ZONES.map((z) => [z, 0]))])) as Record<WritePath, Record<WriteZone, number>>;
  }

  private static noCosts(): Record<CostKind, { n: number; total: number; max: number; samples: number[] }> {
    return Object.fromEntries(COST_KINDS.map((k) => [k, { n: 0, total: 0, max: 0, samples: [] as number[] }])) as Record<
      CostKind,
      { n: number; total: number; max: number; samples: number[] }
    >;
  }

  private static noStages() {
    return { wait: [] as number[], debounce: [] as number[], idle: [] as number[], queue: [] as number[], sinceFirst: [] as number[], depth: [] as number[], requeued: 0 };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The zone of a written unit as painted: the page's band, with LinkedIn's clipped `<main>` handled by `zoneOf`. */
function writeZone(e: IntersectionObserverEntry): WriteZone {
  if (e.isIntersecting) return 'in';
  if (!e.target.isConnected) return 'gone';
  if (!e.boundingClientRect) return 'below';
  return zoneOf(e);
}

/** The trace for a page, or undefined where there is no IntersectionObserver to place units. */
export function hideTrace(win: Window & typeof globalThis): HideTrace | undefined {
  if (typeof win.IntersectionObserver !== 'function') return undefined;
  const raf = typeof win.requestAnimationFrame === 'function' ? (fn: () => void) => void win.requestAnimationFrame(() => fn()) : undefined;
  return new Tracer(win.IntersectionObserver, { frame: raf, doc: win.document, now: () => win.performance.now() });
}
