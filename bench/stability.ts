// Feed stability probe: does content move under the reader while Sifter hides?
//
// Injected into the page's main world by both benches. Recorders:
//
// - `layout-shift` entries (Layout Instability API). Scroll offsets are not layout
//   shifts, so a wheel scroll records nothing by itself; what is left is content
//   moving on screen. Each entry's sources carry the before/after rects, so the
//   probe also reports the largest vertical move of anything visible.
// - A class-attribute MutationObserver that notes, for every unit gaining
//   `sifter-hidden` or `sifter-collapse` (or losing `sifter-hidden`), where it sat
//   relative to the window at that moment, and a ResizeObserver per hidden unit
//   that notes when its height actually changed. They read rects, which forces
//   layout: acceptable in a bench, never in the product.
// - After a collapse above the screen, the element at the middle of the screen,
//   followed for a few frames: a later move means something undid or doubled
//   Sifter's correction.
//
// Zones here are the window's, not the feed's: in a feed that scrolls inside an
// element (LinkedIn), a unit behind the header reads 'straddle' or 'inView'.
//
// A/B with the extension off: whatever the on-run adds is Sifter's.

export const STABILITY_PROBE = `
(() => {
  if (window.__stab) return;
  const stab = { shifts: [], hides: [], collapses: [], releases: [], timelines: [], resizes: [] };
  window.__stab = stab;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        let moved = 0;
        for (const s of e.sources || []) {
          const a = s.previousRect, b = s.currentRect;
          // Only what was on screen before or after counts as "moved under the reader".
          const onScreen = (r) => r && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
          if (!onScreen(a) && !onScreen(b)) continue;
          moved = Math.max(moved, Math.abs((b ? b.top : 0) - (a ? a.top : 0)));
        }
        stab.shifts.push({ t: e.startTime, value: e.value, moved, recent: e.hadRecentInput });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { stab.unsupported = true; }
  const zone = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return 'unmeasured';
    if (r.top >= innerHeight) return 'below';
    if (r.bottom <= 0) return 'above';
    if (r.top < 0) return 'straddle';
    return 'inView';
  };
  const scrollerOf = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
    return document.scrollingElement;
  };
  const follow = (unit) => {
    const ref = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (!ref) return;
    const sc = scrollerOf(unit);
    const row = () => { const u = unit.getBoundingClientRect(); return { t: +performance.now().toFixed(1), top: +ref.getBoundingClientRect().top.toFixed(1), scroll: +sc.scrollTop.toFixed(1), uTop: +u.top.toFixed(1), uH: +u.height.toFixed(1) }; };
    const tl = { window: sc === document.scrollingElement, anchor: getComputedStyle(sc).overflowAnchor, rows: [row()] };
    stab.timelines.push(tl);
    let n = 0;
    const tick = () => { tl.rows.push(row()); if (++n < 6) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
  new MutationObserver((recs) => {
    // One classList.add per class means one record each: count an element once per batch.
    const seenHide = new Set(), seenCollapse = new Set(), seenRelease = new Set();
    for (const r of recs) {
      const el = r.target;
      const was = r.oldValue || '';
      const cls = el.className;
      if (typeof cls !== 'string') continue;
      if (cls.includes('sifter-hidden') && !was.includes('sifter-hidden') && !seenHide.has(el)) {
        seenHide.add(el);
        stab.hides.push({ t: performance.now(), zone: zone(el) });
        // When does a hidden unit's height actually change, and where is it then?
        let lastH = null;
        new ResizeObserver((es) => {
          for (const x of es) {
            const h = Math.round(x.borderBoxSize?.[0]?.blockSize ?? x.contentRect.height);
            if (lastH !== null && h !== lastH) stab.resizes.push({ t: performance.now(), from: lastH, to: h, zone: zone(el) });
            lastH = h;
          }
        }).observe(el);
      }
      if (cls.includes('sifter-collapse') && !was.includes('sifter-collapse') && !seenCollapse.has(el)) {
        seenCollapse.add(el);
        const z = zone(el);
        stab.collapses.push({ t: performance.now(), zone: z });
        if (z === 'above' && stab.timelines.length < 40) follow(el);
      }
      // A release: Sifter took its hide back, and the unit grows again.
      if (!cls.includes('sifter-hidden') && was.includes('sifter-hidden') && !seenRelease.has(el)) {
        seenRelease.add(el);
        stab.releases.push({ t: performance.now(), zone: zone(el) });
      }
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
})();
`;

export type StabRaw = {
  shifts: Array<{ t: number; value: number; moved: number; recent: boolean }>;
  hides: Array<{ t: number; zone: string }>;
  collapses: Array<{ t: number; zone: string }>;
  releases: Array<{ t: number; zone: string }>;
  resizes?: Array<{ t: number; from: number; to: number; zone: string }>;
  timelines?: Array<{ window: boolean; anchor: string; rows: Array<{ t: number; top: number; scroll: number; uTop: number; uH: number }> }>;
  unsupported?: boolean;
};

/** How long after a Sifter class change a layout shift still counts as its consequence. */
const ATTRIBUTION_MS = 250;

/** Counts and sizes only: no page content leaves the page. `since` drops entries before the measured window. */
export function summariseStability(raw: StabRaw | null, since = 0) {
  if (!raw) return null;
  const shifts = raw.shifts.filter((s) => s.t >= since && !s.recent);
  const hides = raw.hides.filter((h) => h.t >= since);
  const collapses = raw.collapses.filter((h) => h.t >= since);
  const byZone = (xs: Array<{ zone: string }>) => {
    const out: Record<string, number> = {};
    for (const x of xs) out[x.zone] = (out[x.zone] ?? 0) + 1;
    return out;
  };
  const releases = (raw.releases ?? []).filter((h) => h.t >= since);
  const moved = shifts.map((s) => s.moved).filter((m) => m > 0.5);
  // Each visible move, blamed on the latest Sifter event shortly before it (or on the site).
  // Proximity, not proof: a site move that lands near a hide is blamed on the hide, so
  // read a `hide:` or `collapse:` entry against the off-run's own moves of the same size.
  const events = [
    ...hides.map((h) => ({ ...h, kind: 'hide' })),
    ...releases.map((h) => ({ ...h, kind: 'release' })),
    // A veiled hide changes height only when it collapses, off screen and later than the hide.
    ...collapses.map((h) => ({ ...h, kind: 'collapse' })),
  ].sort((a, b) => a.t - b.t);
  const blame: Record<string, { n: number; px: number }> = {};
  for (const s of shifts) {
    if (s.moved <= 0.5) continue;
    let cause = 'site';
    for (const e of events) {
      if (e.t > s.t) break;
      if (s.t - e.t <= ATTRIBUTION_MS) cause = `${e.kind}:${e.zone}`;
    }
    const b = (blame[cause] ??= { n: 0, px: 0 });
    b.n++;
    b.px = Math.round(b.px + s.moved);
  }
  return {
    unsupported: raw.unsupported ?? false,
    shifts: shifts.length,
    cls: +shifts.reduce((a, s) => a + s.value, 0).toFixed(4),
    /** Shifts that moved something visible by more than half a pixel. */
    visibleMoves: moved.length,
    maxMovedPx: +Math.max(0, ...moved).toFixed(1),
    sumMovedPx: +moved.reduce((a, b) => a + b, 0).toFixed(0),
    hides: hides.length,
    hidesByZone: byZone(hides),
    collapsesByZone: byZone(collapses),
    releasesByZone: byZone(releases),
    /** Visible moves by likely cause: `hide:<zone>`, `collapse:<zone>`, `release:<zone>`, or `site` when no Sifter event preceded it. */
    movedBy: blame,
    /** Visible moves as [ms into the window, px], to line up against resizeTimes. */
    moveTimes: shifts.filter((x) => x.moved > 0.5).map((x) => [Math.round(x.t - since), Math.round(x.moved)]),
    /** Hidden units' height changes as [ms into the window, px, zone then]. */
    resizeTimes: (raw.resizes ?? []).filter((x) => x.t >= since).map((x) => [Math.round(x.t - since), x.to - x.from, x.zone]),
    /** Per collapse above the screen: [ms, middle element's move, scroll change, unit top, unit height] per frame, moves as deltas from the first row. */
    aboveTimelines: (raw.timelines ?? []).filter((tl) => (tl.rows[0]?.t ?? 0) >= since).map((tl) => ({
      window: tl.window,
      anchor: tl.anchor,
      t0: Math.round((tl.rows[0]?.t ?? 0) - since),
      d: tl.rows.map((r) => [+(r.t - tl.rows[0]!.t).toFixed(0), +(r.top - tl.rows[0]!.top).toFixed(1), +(r.scroll - tl.rows[0]!.scroll).toFixed(1), r.uTop, r.uH]),
    })),
  };
}
