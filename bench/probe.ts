// Scroll-stability probe (Phase 0 of perf/scroll-stability): does what the reader is
// looking at move by itself while they scroll, and is Sifter why?
//
// Injected into the page's main world by `bench:live --probe` and the virtual-feed e2e.
// One requestAnimationFrame loop reads, per frame, the feed scroller's scrollTop and
// scrollHeight and every unit's box. Units are followed by element identity, so for a
// unit on screen in two consecutive frames:
//
//   residual R = Δtop + ΔscrollTop
//
// A plain scroll moves the unit by exactly minus the scroll, so R is 0. A height change
// above it makes R non-zero. That is a visible jump unless something put the scroll
// back (Chrome's scroll anchoring, or Sifter's own `keepInPlace`). Both of those also
// show up in R, so R alone over-counts where anchoring works. Two numbers help here:
//
// - `spread`: the largest minus the smallest Δtop among the units on screen. It needs
//   no idea of the scroll. Above 0, part of the screen moved against the rest: a height
//   change between two things the reader can see.
// - `v`, when the probe drives the scroll itself (`drive`) and so knows the intended
//   step: V = Δtop + intended. That is the exact visible jump, whatever corrected or
//   failed to correct it. Clamped steps (at the top or the end) are flagged and left out.
//
// A MutationObserver notes each Sifter height-state change on a unit (full, tag, blur,
// collapsed) and where the unit sat at the next frame. A row with a moved unit is blamed
// on Sifter when one of those changes landed since the frame before. It is also blamed
// on Sifter when a re-mount came back at another height than the last one Sifter left
// it at, which is the virtualised feed's spacer disagreeing with Sifter's state.
//
// Re-mounts: units are keyed by a hash of their first 120 characters of text, taken
// when first seen, Sifter's placeholder excluded. The page text never leaves the page;
// only 32-bit hashes and counts do. Reading every unit's box each frame forces layout.
// That is fine in a bench and never acceptable in the product.

export const PROBE_SCRIPT = `
(() => {
  if (window.__sifterProbe) return;
  const HID = 'sifter-hidden', COL = 'sifter-collapse', TAG = 'sifter-tag', BLUR = 'sifter-blur', PH = 'data-sifter-placeholder';
  let cfg = null, raw = null, running = false, prev = null, driveSteps = null, driveDone = null, intended = 0, pendingClamp = false;
  let nextId = 1;
  const ids = new WeakMap();
  const stateOf = new WeakMap();
  const pending = [];
  const keys = new Map();
  let revealedKeys = new Set();
  const idOf = (el) => { let id = ids.get(el); if (!id) { id = nextId++; ids.set(el, id); } return id; };
  const state = (el) => {
    const c = el.classList;
    if ((c.contains(HID) && c.contains(COL)) || el.style.display === 'none') return 'collapsed';
    if (c.contains(TAG)) return 'tag';
    if (c.contains(HID) && c.contains(BLUR)) return 'blur';
    return 'full';
  };
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  const textKey = (el) => {
    let t = el.textContent || '';
    const ph = el.querySelector(':scope > [' + PH + ']');
    if (ph) t = t.replace(ph.textContent || '', '');
    return hash(t.replace(/\\s+/g, ' ').trim().slice(0, 120));
  };
  const scroller = () => {
    const el = cfg.scrollerSelector ? document.querySelector(cfg.scrollerSelector) : null;
    if (el && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    return document.scrollingElement;
  };
  const mo = new MutationObserver((recs) => {
    if (!running) return;
    for (const r of recs) {
      const el = r.target;
      if (!(el instanceof Element) || !el.matches(cfg.unitSelector)) continue;
      const before = stateOf.get(el) || 'full';
      const now = state(el);
      if (now === before) continue;
      stateOf.set(el, now);
      pending.push({ el, from: before, to: now, t: performance.now() });
    }
  });
  const zoneOf = (r, vp) => (r.bottom <= vp.top ? 'above' : r.top >= vp.bottom ? 'below' : 'in');
  function tick(t) {
    if (!running) return;
    const sc = scroller();
    const isDoc = sc === document.scrollingElement;
    const sr = isDoc ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
    const vp = { top: Math.max(0, sr.top), bottom: Math.min(innerHeight, sr.bottom) };
    const st = sc.scrollTop, sh = sc.scrollHeight, ch = isDoc ? innerHeight : sc.clientHeight;
    const units = Array.from(document.querySelectorAll(cfg.unitSelector));
    const tops = new Map();
    const row = { t: +t.toFixed(1), st: +st.toFixed(1), sh, n: 0, r: 0, spread: 0, v: null, clamp: pendingClamp, sifter: 0, sifterAbove: 0, sifterIn: 0, sifterBelow: 0, remountJump: 0, births: 0 };
    pendingClamp = false;
    // Sifter's state changes since the last frame, placed where the unit sits now.
    for (const p of pending.splice(0)) {
      const heightChanged = (p.from === 'collapsed') !== (p.to === 'collapsed');
      const z = p.el.isConnected ? zoneOf(p.el.getBoundingClientRect(), vp) : 'gone';
      raw.changes.push({ t: +p.t.toFixed(1), from: p.from, to: p.to, zone: z, height: heightChanged });
      if (!heightChanged) continue;
      row.sifter++;
      if (z === 'above') row.sifterAbove++; else if (z === 'in') row.sifterIn++; else if (z === 'below') row.sifterBelow++;
    }
    // Births: a unit element the probe has not seen. Re-mount when its text key belonged to an element now gone.
    let lastOld = -1;
    const born = [];
    for (let i = 0; i < units.length; i++) {
      if (ids.has(units[i])) lastOld = i; else born.push(i);
    }
    const dts = [];
    for (let i = 0; i < units.length; i++) {
      const el = units[i];
      const r = el.getBoundingClientRect();
      const fresh = !ids.has(el);
      const id = idOf(el);
      if (fresh) {
        row.births++;
        const key = textKey(el);
        const ck = el.getAttribute('componentkey');
        const s = state(el);
        if (!stateOf.has(el)) stateOf.set(el, s);
        const atEnd = i > lastOld;
        const k = keys.get(key);
        if (k && k.el.deref() !== el && !(k.el.deref() && k.el.deref().isConnected)) {
          raw.remounts++;
          if (atEnd) raw.remountAtEnd++; else raw.remountNotAtEnd++;
          if (ck === null) raw.ckMissing++; else if (k.ck === ck) raw.ckStable++; else raw.ckChanged++;
          const wasCollapsed = k.state === 'collapsed', isCollapsed = s === 'collapsed';
          if (wasCollapsed !== isCollapsed) { if (isCollapsed) raw.remountFlips.toCollapsed++; else raw.remountFlips.toFull++; }
          if (Math.abs(r.height - k.h) > 1) {
            raw.remountHeightChanged++;
            // The spacer held the old height: a different one now moves everything below it.
            if (wasCollapsed !== isCollapsed || k.sifterTouched) { raw.remountHeightChangedSifter++; row.remountJump++; }
          }
        } else if (k && k.el.deref() && k.el.deref().isConnected && k.el.deref() !== el) {
          raw.dupText++;
        } else {
          if (atEnd) { raw.newAtEnd++; if (t - raw.lastAppendAt > 500) raw.feedLoads++; raw.lastAppendAt = t; } else raw.newNotAtEnd++;
        }
        keys.set(key, { el: new WeakRef(el), id, ck, state: s, h: r.height, sifterTouched: s !== 'full' || (k ? k.sifterTouched : false) });
        ids.set(el, id);
        el.__probeKey = key;
      } else {
        const k = keys.get(el.__probeKey);
        if (k && k.id === id) { k.h = r.height; k.state = state(el); if (k.state !== 'full') k.sifterTouched = true; }
      }
      const on = r.height > 0 && r.bottom > vp.top && r.top < vp.bottom;
      if (on) {
        // Revealed: a post (by text key, so a re-mount counts once) that reached the screen.
        if (!revealedKeys.has(el.__probeKey)) {
          revealedKeys.add(el.__probeKey);
          raw.revealed++;
          if (state(el) === 'collapsed') raw.revealedCollapsed++;
        }
        tops.set(id, r.top);
        if (prev && prev.tops.has(id)) dts.push(r.top - prev.tops.get(id));
      }
    }
    if (prev && dts.length) {
      const dst = st - prev.st;
      let rMax = 0, vMax = 0, lo = Infinity, hi = -Infinity;
      for (const d of dts) {
        const r = d + dst;
        if (Math.abs(r) > Math.abs(rMax)) rMax = r;
        if (prev.intended !== null) { const v = d + prev.intended; if (Math.abs(v) > Math.abs(vMax)) vMax = v; }
        lo = Math.min(lo, d); hi = Math.max(hi, d);
      }
      row.n = dts.length;
      row.r = +rMax.toFixed(1);
      row.spread = +(hi - lo).toFixed(1);
      row.v = prev.intended === null ? null : +vMax.toFixed(1);
      raw.distance += Math.abs(dst);
      if (dst > 0) raw.down += dst; else raw.up -= dst;
    }
    if (!isDoc && raw.anchor === null) raw.anchor = getComputedStyle(sc).overflowAnchor;
    raw.rows.push(row);
    raw.unitsMax = Math.max(raw.unitsMax, units.length);
    // The driver's next step, applied after the measurement so the next row sees it whole.
    let next = null;
    if (driveSteps) {
      if (driveSteps.length) {
        const step = driveSteps.shift();
        const max = sh - ch;
        const target = st + step;
        if (target < 0 || target > max) pendingClamp = true;
        sc.scrollTop = target;
        next = step;
      } else { const d = driveDone; driveSteps = null; driveDone = null; d(); }
    }
    prev = { st, tops, intended: next };
    requestAnimationFrame(tick);
  }
  window.__sifterProbe = {
    start(c) {
      cfg = c;
      this.reset();
      // Everything already on the page is known, not born.
      for (const el of document.querySelectorAll(c.unitSelector)) {
        idOf(el); const s = state(el); stateOf.set(el, s);
        const key = textKey(el); el.__probeKey = key;
        keys.set(key, { el: new WeakRef(el), id: ids.get(el), ck: el.getAttribute('componentkey'), state: s, h: el.getBoundingClientRect().height, sifterTouched: s !== 'full' });
      }
      prev = null;
      running = true;
      mo.observe(document, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      requestAnimationFrame(tick);
    },
    /** Zero the counters and rows but keep every unit seen so far, so a later return still reads as a re-mount. */
    reset() {
      raw = { rows: [], changes: [], remounts: 0, remountAtEnd: 0, remountNotAtEnd: 0, remountFlips: { toCollapsed: 0, toFull: 0 }, remountHeightChanged: 0, remountHeightChangedSifter: 0, ckStable: 0, ckChanged: 0, ckMissing: 0, newAtEnd: 0, newNotAtEnd: 0, dupText: 0, feedLoads: 0, lastAppendAt: -1e9, distance: 0, down: 0, up: 0, unitsMax: 0, anchor: null, revealed: 0, revealedCollapsed: 0 };
      revealedKeys = new Set();
      pending.length = 0;
      prev = null;
    },
    /** Scroll the feed by these px, one step per frame. Resolves after the last step's frame was measured. */
    drive(steps) { return new Promise((done) => { driveSteps = steps.slice(); driveDone = done; }); },
    stop() { running = false; mo.disconnect(); const r = raw; return r; },
  };
})();
`;

export type ProbeRow = {
  t: number;
  st: number;
  sh: number;
  n: number;
  r: number;
  spread: number;
  v: number | null;
  clamp: boolean;
  sifter: number;
  sifterAbove: number;
  sifterIn: number;
  sifterBelow: number;
  remountJump: number;
  births: number;
};
export type ProbeRaw = {
  rows: ProbeRow[];
  changes: Array<{ t: number; from: string; to: string; zone: string; height: boolean }>;
  remounts: number;
  remountAtEnd: number;
  remountNotAtEnd: number;
  remountFlips: { toCollapsed: number; toFull: number };
  remountHeightChanged: number;
  remountHeightChangedSifter: number;
  ckStable: number;
  ckChanged: number;
  ckMissing: number;
  newAtEnd: number;
  newNotAtEnd: number;
  dupText: number;
  feedLoads: number;
  distance: number;
  down: number;
  up: number;
  unitsMax: number;
  anchor: string | null;
  revealed: number;
  revealedCollapsed: number;
};

/** Below this a move is sub-pixel rounding, not a jump. */
const PX = 1;

type Bucket = { frames: number; px: number; max: number };
const bucket = (): Bucket => ({ frames: 0, px: 0, max: 0 });
const add = (b: Bucket, x: number) => {
  b.frames++;
  b.px = Math.round(b.px + Math.abs(x));
  b.max = Math.max(b.max, Math.round(Math.abs(x)));
};

/**
 * Counts only, never page content. `sifterScrolls`: the trace's own scroll corrections
 * (`performance.now()` times, which the isolated world shares with the page), so a
 * residual Sifter already undid in the same frame is counted as corrected, not as a jump.
 */
export function summariseProbe(raw: ProbeRaw | null, sifterScrolls: number[] = []) {
  if (!raw) return null;
  const rows = raw.rows;
  const blame = (i: number): 'sifter' | 'site' => {
    const row = rows[i]!;
    const before = rows[i - 1];
    const recent = row.sifter - row.sifterBelow + (before ? before.sifter - before.sifterBelow : 0);
    return recent > 0 || row.remountJump > 0 ? 'sifter' : 'site';
  };
  const corrected = (row: ProbeRow, i: number) => {
    const from = rows[i - 1]?.t ?? row.t - 20;
    return sifterScrolls.some((s) => s > from && s <= row.t);
  };
  const residual = { sifter: bucket(), site: bucket(), correctedBySifter: 0 };
  const relative = { sifter: bucket(), site: bucket() };
  const visible = { sifter: bucket(), site: bucket(), measured: 0 };
  let clamps = 0;
  let scrollHeightChanges = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.sh !== rows[i - 1]!.sh) scrollHeightChanges++;
    if (row.clamp) clamps++;
    if (row.n === 0) continue;
    const who = blame(i);
    if (Math.abs(row.r) > PX) {
      if (corrected(row, i)) residual.correctedBySifter++;
      else add(residual[who], row.r);
    }
    if (row.spread > PX) add(relative[who], row.spread);
    // A clamped step scrolled less than intended, so V would read the shortfall as a jump.
    if (row.v !== null && !row.clamp) {
      visible.measured++;
      if (Math.abs(row.v) > PX) add(visible[who], row.v);
    }
  }
  const changes = { byZone: {} as Record<string, number>, heightChanges: 0 };
  for (const c of raw.changes) {
    const k = `${c.from}>${c.to}:${c.zone}`;
    changes.byZone[k] = (changes.byZone[k] ?? 0) + 1;
    if (c.height) changes.heightChanges++;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    frames: rows.length,
    seconds: first && last ? +((last.t - first.t) / 1000).toFixed(1) : 0,
    distance: { total: Math.round(raw.distance), down: Math.round(raw.down), up: Math.round(raw.up) },
    /** The scroller's computed overflow-anchor: 'auto' means Chrome may have corrected some residuals unseen. */
    anchor: raw.anchor,
    /** Driven steps cut short at the top or the end (left out of `visible`). */
    clamps,
    /** R = Δtop + ΔscrollTop on screen, by blame. Over-counts where anchoring corrected. */
    residual,
    /** Part of the screen moved against the rest. */
    relative,
    /** Exact visible jumps, only when the probe drove the scroll. */
    visible,
    sifterChanges: changes,
    remounts: {
      n: raw.remounts,
      flips: raw.remountFlips,
      heightChanged: raw.remountHeightChanged,
      heightChangedAfterSifter: raw.remountHeightChangedSifter,
      atEnd: raw.remountAtEnd,
      notAtEnd: raw.remountNotAtEnd,
    },
    componentkey: { stable: raw.ckStable, changed: raw.ckChanged, missing: raw.ckMissing },
    appends: { newAtEnd: raw.newAtEnd, newNotAtEnd: raw.newNotAtEnd, sameTextTwice: raw.dupText },
    feedLoads: raw.feedLoads,
    scrollHeightChanges,
    unitsMax: raw.unitsMax,
    /** Posts that reached the screen (once each), and how many of those were collapsed when they did. */
    revealed: { n: raw.revealed, collapsed: raw.revealedCollapsed },
    /** Feed loads per post revealed: same as off when Sifter's collapses only make the same distance cover more posts. */
    loadsPerRevealed: raw.revealed ? +(raw.feedLoads / raw.revealed).toFixed(3) : null,
  };
}
export type ProbeSummary = NonNullable<ReturnType<typeof summariseProbe>>;

export type Pattern = 'down' | 'up' | 'reverse' | 'fling' | 'read';

/**
 * Wheel ticks for a pattern, as [deltaY, ms to wait after]. The caller plays a `down`
 * plan before an `up` one, outside the measured window, so there is something above to
 * come back to (`bench:live` does, then calls the probe's `reset`).
 */
export function wheelPlan(pattern: Pattern, seconds: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let ms = 0;
  const push = (dy: number, wait: number) => {
    out.push([dy, wait]);
    ms += wait;
  };
  let i = 0;
  while (ms < seconds * 1000) {
    i++;
    if (pattern === 'read') {
      // A reader: about one post's worth of wheel, then a few seconds on it.
      push(120, 40);
      if (i % 5 === 0) push(0, 2500);
    } else if (pattern === 'fling') {
      push(360, 16);
      if (i % 10 === 0) push(0, 800);
    } else if (pattern === 'reverse') {
      push(i % 36 < 24 ? 120 : -120, 40);
      if (i % 12 === 0) push(0, 400);
    } else {
      push(pattern === 'up' ? -120 : 120, 40);
      if (i % 12 === 0) push(0, 400);
    }
  }
  return out;
}

/** Per-frame steps for the probe's own driver (`drive`): down, back up, then reverse cycles. */
export function driveSteps(pattern: 'down' | 'up' | 'reverse', frames: number, px: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    if (pattern === 'down') out.push(px);
    else if (pattern === 'up') out.push(-px);
    else out.push(i % 36 < 24 ? px : -px);
    // A reader's pause every second of scrolling.
    if (i % 60 === 59) for (let k = 0; k < 15; k++) out.push(0);
  }
  return out;
}
