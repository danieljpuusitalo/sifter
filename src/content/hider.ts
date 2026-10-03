import type { HideCategory, HideMode } from '../types';
import type { LateTracker } from './viewport';

// Hard rule 5: never remove nodes. Hide by adding a class to the unit root (plus,
// for "hide" mode only, an inline style), so infinite scroll and site JS keep
// working, and every hide is reversible in one click from the placeholder
// (BRIEF.md §6).

export const HIDDEN_CLASS = 'sifter-hidden';
export const COLLAPSE_CLASS = 'sifter-collapse';
export const BLUR_CLASS = 'sifter-blur';
/**
 * A late catch the reader may be looking at: the post stays exactly as the site drew
 * it, with a zero-height "Sponsored · Hide" pill on top. Nothing moves. It becomes a
 * real hide on a click, or once it is a full screen below the reader.
 */
export const TAG_CLASS = 'sifter-tag';
export const PLACEHOLDER_ATTR = 'data-sifter-placeholder';
/** Marks the fallback `<style>` element when the document's realm has no constructable sheets. */
const UNIT_STYLE_ATTR = 'data-sifter';

const LABELS: Record<HideCategory, string> = {
  sponsored: 'Hidden sponsored post',
  suggested: 'Hidden suggestion',
  affiliate: 'Hidden affiliate post',
  custom: 'Hidden by your filter',
  manual: 'Hidden by you',
};

/** What a tag says: the post is still in plain view, so no "Hidden" and no first line. */
const TAG_LABELS: Record<HideCategory, string> = {
  sponsored: 'Sponsored',
  suggested: 'Suggested',
  affiliate: 'Affiliate',
  custom: 'Matches your filter',
  manual: 'Hidden by you',
};

/** The second button always means "stop hiding this one", said per category. */
const KEEP_LABELS: Record<HideCategory, string> = {
  sponsored: 'Not an ad',
  suggested: 'Always show',
  affiliate: 'Not an ad',
  custom: 'Always show',
  manual: 'Undo',
};

type Record_ = {
  category: HideCategory;
  /** First rendered line of the unit's text, shown after a middle dot. Undefined when the decision path had none (block rules). */
  hint?: string;
  placeholder: HTMLElement | null;
  /** The mode this record was last hidden under: setMode migrates it, show/rehide reuse it. */
  mode: HideMode;
  /** True once the user clicked "Show": content is visible, but the placeholder stays as a "Hide" bar. */
  shown: boolean;
  /** Caught late while the reader could see it: tagged, not hidden, until a click or the tracker settles it. */
  tagged: boolean;
  /** Only "hide" mode touches the unit's own inline style; collapse/blur hide via the shared stylesheet instead. */
  prev: { display: string; displayPriority: string } | null;
};

export type HiderCallbacks = {
  onShow: (unit: Element) => void;
  onNotAd: (unit: Element) => void;
  onRehide: (unit: Element) => void;
  /** "Hide" on a tag: the reader asked for the move. */
  onHideTag: (unit: Element) => void;
};

/**
 * Placeholder shadow roots, keyed by host element. Kept `mode: 'open'` (see the
 * comment on `makePlaceholder`) but the button handlers below are what actually
 * matters: they refuse anything the page itself dispatched. This map is a
 * dev/test seam only, not a security boundary.
 */
const shadowRoots = new WeakMap<Element, ShadowRoot>();

/** Test-only accessor: the placeholder's shadow root for a given host element. */
export function placeholderRoot(host: Element): ShadowRoot | undefined {
  return shadowRoots.get(host);
}

const PLACEHOLDER_CSS = `
:host { display: block; }
.row {
  display: flex; align-items: center; gap: 12px;
  min-height: 36px; box-sizing: border-box; padding: 8px 12px;
  font: inherit; font-size: 13px; line-height: 1.4;
  color: currentColor; opacity: 0.7;
  border: 1px solid currentColor; border-radius: 8px; margin: 4px 0;
}
.label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button {
  all: unset; cursor: pointer; font: inherit; color: inherit; flex: 0 0 auto;
  text-decoration: underline; text-underline-offset: 2px;
}
button:hover { opacity: 1; }
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 2px; }
:host([data-tag]) .row {
  position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
  min-height: 0; max-width: calc(100% - 24px); padding: 3px 10px; margin: 0; gap: 10px;
  font-size: 12px; white-space: nowrap;
  color: #fff; background: rgba(0, 0, 0, 0.72); opacity: 1; border: 0; border-radius: 999px;
}
:host([data-tag]) .label { flex: 0 1 auto; }
`;

/**
 * One constructed stylesheet per document, shared by every placeholder through
 * `adoptedStyleSheets`. A `<style>` element per placeholder made the browser parse
 * the same CSS once per hide (one LinkedIn apply phase measured 7.9 ms). `null`
 * means the document's realm has no constructable sheets; then fall back to a
 * `<style>` element.
 */
const sheets = new WeakMap<Document, CSSStyleSheet | null>();

function placeholderSheet(doc: Document): CSSStyleSheet | null {
  const known = sheets.get(doc);
  if (known !== undefined) return known;
  let sheet: CSSStyleSheet | null = null;
  try {
    // The sheet must come from the page's own realm, or adopting it throws.
    const Ctor = doc.defaultView?.CSSStyleSheet;
    if (Ctor && typeof Ctor.prototype.replaceSync === 'function') {
      sheet = new Ctor();
      sheet.replaceSync(PLACEHOLDER_CSS);
    }
  } catch {
    sheet = null;
  }
  sheets.set(doc, sheet);
  return sheet;
}

/** Test-only accessor: whether placeholders in this document share one constructed sheet. */
export function usesSharedSheet(doc: Document): boolean {
  return placeholderSheet(doc) !== null;
}

/**
 * The rules that hide a unit's own content while the placeholder (its first
 * child) stays visible: LinkedIn's virtualised feed measures a `display:none`
 * unit at 0 px and parks the whole slot off-screen, taking any previous-sibling
 * placeholder with it. Styling the unit's *children* instead, from one shared
 * document-level sheet, keeps the unit itself measurable.
 */
//
// A tag (and blur mode) never changes the unit's height: the placeholder is a
// zero-height box whose row overflows on top of the content, so inserting it adds
// nothing to layout. A tagged unit's own content is untouched, so a rescan reads it
// exactly as the site built it.
const UNIT_CSS = `
.${HIDDEN_CLASS}.${COLLAPSE_CLASS} > :not([${PLACEHOLDER_ATTR}]) { display: none !important; }
.${HIDDEN_CLASS}.${BLUR_CLASS} > :not([${PLACEHOLDER_ATTR}]) { filter: blur(12px) !important; pointer-events: none !important; }
.${HIDDEN_CLASS}.${COLLAPSE_CLASS} { min-height: 0 !important; max-height: none !important; height: auto !important; }
.${TAG_CLASS} > [${PLACEHOLDER_ATTR}], .${HIDDEN_CLASS}.${BLUR_CLASS} > [${PLACEHOLDER_ATTR}] { display: flow-root !important; height: 0 !important; position: relative !important; z-index: 1 !important; }
`;

const unitSheets = new WeakMap<Document, CSSStyleSheet | null>();

/** Installs the unit-hiding rules on `doc` once, adopted or as a fallback `<style>`. */
function ensureUnitStylesheet(doc: Document): void {
  if (unitSheets.has(doc)) return;
  let sheet: CSSStyleSheet | null = null;
  try {
    const Ctor = doc.defaultView?.CSSStyleSheet;
    if (Ctor && typeof Ctor.prototype.replaceSync === 'function') {
      sheet = new Ctor();
      sheet.replaceSync(UNIT_CSS);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    }
  } catch {
    sheet = null;
  }
  unitSheets.set(doc, sheet);
  if (!sheet && !doc.querySelector(`style[${UNIT_STYLE_ATTR}]`)) {
    const style = doc.createElement('style');
    style.setAttribute(UNIT_STYLE_ATTR, '');
    style.textContent = UNIT_CSS;
    (doc.head ?? doc.documentElement).append(style);
  }
}

/** Test-only accessor: the installed unit-hiding CSS text for `doc`, whichever form it took. */
export function unitStylesheetText(doc: Document): string {
  const sheet = unitSheets.get(doc);
  if (sheet) {
    try {
      return Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
    } catch {
      return '';
    }
  }
  return doc.querySelector(`style[${UNIT_STYLE_ATTR}]`)?.textContent ?? '';
}

export class Hider {
  private records = new WeakMap<Element, Record_>();
  /** Units currently, visibly hidden (excludes "shown" and tagged ones): what `hiddenUnits()`/counts report. */
  private hidden = new Set<Element>();
  /** Every unit with a live record, hidden, tagged or shown: what a hard reset (`unhide`/`prune`/`setMode`) must reach. */
  private tracked = new Set<Element>();

  /**
   * @param late When given, a hide decided after the page settled lands as a tag
   *   (the post stays put) unless the tracker says it is far below the reader.
   *   Without it (tests, evals, a page with no IntersectionObserver) hides apply at
   *   once, as before.
   */
  constructor(
    private doc: Document,
    private mode: HideMode,
    private cb: HiderCallbacks,
    private late?: LateTracker,
  ) {}

  /** Sifter tracks this unit: hidden, tagged or shown. */
  isHidden(unit: Element): boolean {
    return this.records.has(unit);
  }

  /** Caught late and tagged in place: the post is still fully visible. */
  isTagged(unit: Element): boolean {
    return this.records.get(unit)?.tagged ?? false;
  }

  /**
   * A tag becomes the real hide. The tracker calls this once the unit is far below
   * the reader; the scanner calls it (inside `keepInPlace`) when the reader clicks Hide.
   */
  settle(unit: Element): void {
    const rec = this.records.get(unit);
    if (!rec || !rec.tagged) return;
    this.untag(unit, rec);
    this.hidden.add(unit);
    const el = unit as HTMLElement;
    el.classList.add(HIDDEN_CLASS);
    this.present(el, rec);
  }

  /** Stop the viewport tracker (the scanner is being torn down). */
  dispose(): void {
    this.late?.disconnect();
  }

  /** Units hidden right now: what the popup counts. Tags are not hides. */
  hiddenUnits(): Element[] {
    return [...this.hidden];
  }

  /** Hidden or tagged: every unit a settings change must re-decide or a "Show all" must release. */
  trackedHides(): Element[] {
    return [...this.tracked].filter((u) => !this.records.get(u)?.shown);
  }

  /** The placeholder Sifter put inside a tracked unit, so a read can lift it out of the way. */
  placeholderOf(unit: Element): HTMLElement | null {
    return this.records.get(unit)?.placeholder ?? null;
  }

  /** The category a unit is currently hidden or shown under, if Sifter is tracking it. */
  categoryOf(unit: Element): HideCategory | undefined {
    return this.records.get(unit)?.category;
  }

  /**
   * @param now Apply the real mode at once, never a tag: the pre-paint lane (the
   *   post has not been drawn yet) and hides the reader asked for.
   */
  hide(unit: Element, category: HideCategory, hint?: string, now = false): void {
    const existing = this.records.get(unit);
    if (existing) {
      const changed = existing.category !== category || existing.hint !== hint;
      existing.category = category;
      existing.hint = hint;
      if (changed) this.renderPlaceholder(existing, unit);
      if (now) this.settle(unit);
      return;
    }
    const rec: Record_ = {
      category,
      hint,
      placeholder: null,
      mode: this.mode,
      shown: false,
      tagged: false,
      prev: null,
    };
    this.records.set(unit, rec);
    this.tracked.add(unit);
    // Blur never changes layout, and while the page is still loading nobody is reading yet.
    const tag = !now && !!this.late && this.mode !== 'blur' && !this.late.loadHide?.();
    if (!tag) {
      this.hidden.add(unit);
      (unit as HTMLElement).classList.add(HIDDEN_CLASS);
    }
    this.applyMode(unit, rec, tag);
  }

  /** Hard reset: removes the placeholder and the record entirely. Used for a full unhide, disabling, and "Not an ad". */
  unhide(unit: Element): void {
    const rec = this.records.get(unit);
    if (!rec) return;
    this.records.delete(unit);
    this.hidden.delete(unit);
    this.tracked.delete(unit);
    this.late?.unwatch(unit);
    const el = unit as HTMLElement;
    el.classList.remove(HIDDEN_CLASS, TAG_CLASS);
    const modeClass = this.classFor(rec.mode);
    if (modeClass) el.classList.remove(modeClass);
    this.restoreStyle(el, rec);
    rec.placeholder?.remove();
  }

  unhideAll(): void {
    for (const u of [...this.tracked]) this.unhide(u);
  }

  /**
   * "Show": reveals the unit's own content but keeps the placeholder, now reading
   * "Showing…" with a Hide button, so the reveal is reversible.
   */
  show(unit: Element): void {
    const rec = this.records.get(unit);
    if (!rec || rec.shown) return;
    rec.shown = true;
    if (rec.tagged) {
      // Already in plain view: drop the tag; the bar the reader can rehide from comes back with the next hide.
      this.untag(unit, rec);
      if (rec.placeholder) this.renderPlaceholder(rec, unit);
      return;
    }
    this.hidden.delete(unit);
    const el = unit as HTMLElement;
    el.classList.remove(HIDDEN_CLASS);
    const modeClass = this.classFor(rec.mode);
    if (modeClass) el.classList.remove(modeClass);
    if (rec.mode === 'hide') this.restoreStyle(el, rec);
    if (rec.placeholder) this.renderPlaceholder(rec, unit);
  }

  /** "Hide" on a shown placeholder: puts the unit back into the hidden state under the same category. */
  rehide(unit: Element): void {
    const rec = this.records.get(unit);
    if (!rec || !rec.shown) return;
    rec.shown = false;
    this.hidden.add(unit);
    const el = unit as HTMLElement;
    el.classList.add(HIDDEN_CLASS);
    // A click on the bar: collapse at once, the reader asked for it.
    if (!rec.placeholder && rec.mode !== 'hide') {
      rec.placeholder = this.makePlaceholder(unit, rec);
      unit.prepend(rec.placeholder);
    }
    this.present(el, rec);
    if (rec.placeholder) this.renderPlaceholder(rec, unit);
  }

  setMode(mode: HideMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const u of this.tracked) {
      const rec = this.records.get(u);
      if (!rec) continue;
      if (rec.shown) {
        // Not currently presented hidden: just remember the mode for the next hide.
        rec.mode = mode;
        continue;
      }
      if (rec.tagged) {
        // A tag looks the same in every mode. Blur moves nothing, so it may apply at once.
        rec.mode = mode;
        if (mode === 'blur') this.settle(u);
        continue;
      }
      const el = u as HTMLElement;
      const oldClass = this.classFor(rec.mode);
      if (oldClass) el.classList.remove(oldClass);
      this.restoreStyle(el, rec);
      rec.prev = null;
      rec.placeholder?.remove();
      rec.placeholder = null;
      this.applyMode(u, rec, false);
    }
  }

  /**
   * Sites recycle and remove feed nodes. Drop records for units that left the
   * DOM, and re-seat placeholders that got separated from their unit (they live
   * inside it, as its first child).
   */
  prune(): void {
    for (const u of [...this.tracked]) {
      const rec = this.records.get(u);
      if (!u.isConnected) {
        this.late?.unwatch(u);
        rec?.placeholder?.remove();
        this.records.delete(u);
        this.hidden.delete(u);
        this.tracked.delete(u);
      } else if (rec?.placeholder && (rec.placeholder.parentNode !== u || u.firstElementChild !== rec.placeholder)) {
        u.prepend(rec.placeholder);
      }
    }
  }

  private classFor(mode: HideMode): string | null {
    if (mode === 'collapse') return COLLAPSE_CLASS;
    if (mode === 'blur') return BLUR_CLASS;
    return null;
  }

  /**
   * Presents a fresh (or re-moded) hide: the placeholder for collapse and blur (and
   * for a tag in every mode), then either the tag or the mode itself.
   */
  private applyMode(unit: Element, rec: Record_, tag: boolean): void {
    const el = unit as HTMLElement;
    rec.mode = this.mode;
    rec.prev = null;
    if (this.mode !== 'hide' || tag) ensureUnitStylesheet(this.doc);
    rec.tagged = tag;
    // "Hide" mode has no placeholder once hidden: the unit itself goes display:none.
    if (this.mode !== 'hide' || tag) {
      rec.placeholder = this.makePlaceholder(unit, rec);
      unit.prepend(rec.placeholder);
    }
    if (tag) {
      el.classList.add(TAG_CLASS);
      this.late?.watch(unit);
      return;
    }
    this.present(el, rec);
  }

  /** Lifts the tag: the unit is untouched again, its placeholder (if the mode keeps one) a normal bar. */
  private untag(unit: Element, rec: Record_): void {
    rec.tagged = false;
    this.late?.unwatch(unit);
    (unit as HTMLElement).classList.remove(TAG_CLASS);
    if (rec.mode === 'hide') {
      rec.placeholder?.remove();
      rec.placeholder = null;
    } else if (rec.placeholder) {
      this.renderPlaceholder(rec, unit);
    }
  }

  /** The mode's own hide, which may change the unit's height. Keeps the first saved inline display. */
  private present(el: HTMLElement, rec: Record_): void {
    if (rec.mode === 'hide') {
      rec.prev ??= {
        display: el.style.getPropertyValue('display'),
        displayPriority: el.style.getPropertyPriority('display'),
      };
      el.style.setProperty('display', 'none', 'important');
      return;
    }
    el.classList.add(this.classFor(rec.mode) as string);
  }

  private restoreStyle(el: HTMLElement, rec: Record_): void {
    const prev = rec.prev;
    if (!prev) return;
    if (prev.display) el.style.setProperty('display', prev.display, prev.displayPriority);
    else el.style.removeProperty('display');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }

  private labelText(rec: Record_): string {
    if (rec.tagged) return TAG_LABELS[rec.category];
    const base = LABELS[rec.category];
    const text = rec.shown ? `Showing ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
    return rec.hint ? `${text} · ${rec.hint}` : text;
  }

  private makePlaceholder(unit: Element, rec: Record_): HTMLElement {
    const host = this.doc.createElement('div');
    // Open so e2e tests can reach the buttons; nothing in it is secret. The real
    // guard against page script driving these buttons is the isTrusted check
    // below, not shadow mode: a closed root only hides the DOM from casual
    // access, and page script can already see and click host/button elements
    // it can locate by attribute regardless of shadow mode.
    const root = host.attachShadow({ mode: 'open' });
    shadowRoots.set(host, root);
    let adopted = false;
    const sheet = placeholderSheet(this.doc);
    if (sheet) {
      try {
        root.adoptedStyleSheets = [sheet];
        adopted = true;
      } catch {
        adopted = false;
      }
    }
    if (!adopted) {
      const style = this.doc.createElement('style');
      style.textContent = PLACEHOLDER_CSS;
      root.append(style);
    }
    const row = this.doc.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'group');
    root.append(row);
    rec.placeholder = host;
    this.renderPlaceholder(rec, unit);
    return host;
  }

  /** (Re)builds the placeholder's row for the record's current state: category, hint and shown/hidden/tagged. */
  private renderPlaceholder(rec: Record_, unit: Element): void {
    const host = rec.placeholder;
    if (!host) return;
    host.setAttribute(PLACEHOLDER_ATTR, rec.category);
    if (rec.tagged) host.setAttribute('data-tag', '');
    else host.removeAttribute('data-tag');
    const root = host.shadowRoot;
    const row = root?.querySelector('.row');
    if (!row) return;
    while (row.firstChild) row.removeChild(row.firstChild);
    const label = this.doc.createElement('span');
    label.className = 'label';
    label.textContent = this.labelText(rec);
    row.append(label);
    if (rec.tagged) {
      row.append(this.button('Hide', 'hide-tag', () => this.cb.onHideTag(unit)));
    } else if (rec.shown) {
      row.append(this.button('Hide', 'hide', () => this.cb.onRehide(unit)));
    } else {
      row.append(this.button('Show', 'show', () => this.cb.onShow(unit)));
    }
    row.append(this.button(KEEP_LABELS[rec.category], 'not-ad', () => this.cb.onNotAd(unit)));
  }

  private button(text: string, act: string, onClick: () => void): HTMLButtonElement {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.dataset.act = act;
    b.addEventListener('click', (e) => {
      // Page script can dispatch a synthetic click on any element it can find,
      // shadow DOM or not. Only a real click may reveal a post or persist an
      // override.
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }
}
