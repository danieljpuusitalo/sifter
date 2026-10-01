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

export type TraceStats = {
  /** Content to hide, in ms, by where the unit was when queued and when hidden. */
  latency: {
    /** On screen when its content arrived, and still when hidden. */
    alreadyOnScreen: LatencySummary;
    /** Off screen when queued, on screen by the time it was hidden. */
    enteredWhileQueued: LatencySummary;
    /** Off screen when hidden: the reader never saw it. */
    offScreen: LatencySummary;
  };
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
  /** The scan is collecting: returns the moment the batch went dirty, and starts a new batch. */
  takeDirty(now: number): number;
  /** A collected unit entered the queue. */
  queued(unit: Element, since: number): void;
  /** A queued unit turned out empty: its content has not arrived yet. */
  empty(unit: Element): void;
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

type Pending = { since: number; inViewAtQueue?: boolean; hiddenAt?: number; awaitingHideZone?: boolean };

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
  private readonly pending = new Map<Element, Pending>();
  private readonly hidden = new Map<Element, HideWhy & { at: number }>();
  private readonly userShown = new Set<Element>();
  private lat = { alreadyOnScreen: [] as number[], enteredWhileQueued: [] as number[], offScreen: [] as number[] };
  private flips: Flip[] = [];
  private flipCount = 0;
  private hiddenLeft = 0;
  private readonly io: IntersectionObserver | null;

  constructor(IO: typeof IntersectionObserver | undefined) {
    this.io = IO ? new IO((entries) => this.onEntries(entries)) : null;
  }

  dirty(now: number): void {
    if (this.dirtySince === null) this.dirtySince = now;
  }

  takeDirty(now: number): number {
    const since = this.dirtySince ?? now;
    this.dirtySince = null;
    return since;
  }

  /**
   * The latest batch that queued it counts, not the first: a post that was decided
   * "no hide" and later gains its signal (a social line filling in) was waiting on
   * the site, not on the scanner. Re-observing gives a fresh zone for that batch.
   */
  queued(unit: Element, since: number): void {
    if (this.hidden.has(unit)) return;
    this.pending.set(unit, { since });
    if (!this.io) return;
    this.io.unobserve(unit);
    this.io.observe(unit);
  }

  empty(unit: Element): void {
    if (this.pending.delete(unit)) this.io?.unobserve(unit);
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
      latency: {
        alreadyOnScreen: summary(this.lat.alreadyOnScreen),
        enteredWhileQueued: summary(this.lat.enteredWhileQueued),
        offScreen: summary(this.lat.offScreen),
      },
      flips: [...this.flips],
      flipCount: this.flipCount,
      hiddenLeft: this.hiddenLeft,
    };
  }

  reset(): void {
    this.lat = { alreadyOnScreen: [], enteredWhileQueued: [], offScreen: [] };
    this.flips = [];
    this.flipCount = 0;
    this.hiddenLeft = 0;
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
      this.record(p, e.isIntersecting);
      this.pending.delete(e.target);
    }
  }

  /** Called with the zone at the hide. A unit queued and never hidden leaves with its element (a WeakMap). */
  private record(p: Pending, inViewAtHide: boolean): void {
    const ms = (p.hiddenAt as number) - p.since;
    const bucket = !inViewAtHide ? this.lat.offScreen : p.inViewAtQueue ? this.lat.alreadyOnScreen : this.lat.enteredWhileQueued;
    if (bucket.length < MAX_SAMPLES) bucket.push(ms);
  }
}

/** The trace for a page, or undefined where there is no IntersectionObserver to place units. */
export function hideTrace(win: Window & typeof globalThis): HideTrace | undefined {
  return typeof win.IntersectionObserver === 'function' ? new Tracer(win.IntersectionObserver) : undefined;
}
