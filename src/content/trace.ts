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

export type TraceStats = {
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
  stats(): TraceStats;
  /** Bench hook: start a fresh window (the counters before were the page load). */
  reset(): void;
}

export const MAX_FLIPS = 50;
const MAX_SAMPLES = 5000;

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
  private readonly pending = new Map<Element, Pending>();
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

  constructor(IO: typeof IntersectionObserver | undefined) {
    this.io = IO ? new IO((entries) => this.onEntries(entries)) : null;
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

  private static noStages() {
    return { wait: [] as number[], debounce: [] as number[], idle: [] as number[], queue: [] as number[], sinceFirst: [] as number[], depth: [] as number[], requeued: 0 };
  }
}

/** The trace for a page, or undefined where there is no IntersectionObserver to place units. */
export function hideTrace(win: Window & typeof globalThis): HideTrace | undefined {
  return typeof win.IntersectionObserver === 'function' ? new Tracer(win.IntersectionObserver) : undefined;
}
