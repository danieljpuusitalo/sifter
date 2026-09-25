import type { HideCategory, HideMode } from '../types';

// Hard rule 5: never remove nodes. Hide by adding a class to the unit root (plus,
// for "hide" mode only, an inline style), so infinite scroll and site JS keep
// working, and every hide is reversible in one click from the placeholder
// (BRIEF.md §6).

export const HIDDEN_CLASS = 'sifter-hidden';
export const COLLAPSE_CLASS = 'sifter-collapse';
export const BLUR_CLASS = 'sifter-blur';
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
  /** Only "hide" mode touches the unit's own inline style; collapse/blur hide via the shared stylesheet instead. */
  prev: { display: string; displayPriority: string } | null;
};

export type HiderCallbacks = {
  onShow: (unit: Element) => void;
  onNotAd: (unit: Element) => void;
  onRehide: (unit: Element) => void;
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
const UNIT_CSS = `
.${HIDDEN_CLASS}.${COLLAPSE_CLASS} > :not([${PLACEHOLDER_ATTR}]) { display: none !important; }
.${HIDDEN_CLASS}.${BLUR_CLASS} > :not([${PLACEHOLDER_ATTR}]) { filter: blur(12px) !important; pointer-events: none !important; }
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
  /** Units currently, visibly hidden (excludes "shown" ones): what `hiddenUnits()`/counts report. */
  private hidden = new Set<Element>();
  /** Every unit with a live record, hidden or shown: what a hard reset (`unhide`/`prune`/`setMode`) must reach. */
  private tracked = new Set<Element>();

  constructor(
    private doc: Document,
    private mode: HideMode,
    private cb: HiderCallbacks,
  ) {}

  isHidden(unit: Element): boolean {
    return this.records.has(unit);
  }

  hiddenUnits(): Element[] {
    return [...this.hidden];
  }

  /** The category a unit is currently hidden or shown under, if Sifter is tracking it. */
  categoryOf(unit: Element): HideCategory | undefined {
    return this.records.get(unit)?.category;
  }

  hide(unit: Element, category: HideCategory, hint?: string): void {
    const existing = this.records.get(unit);
    if (existing) {
      const changed = existing.category !== category || existing.hint !== hint;
      existing.category = category;
      existing.hint = hint;
      if (changed) this.renderPlaceholder(existing, unit);
      return;
    }
    const rec: Record_ = {
      category,
      hint,
      placeholder: null,
      mode: this.mode,
      shown: false,
      prev: null,
    };
    this.records.set(unit, rec);
    this.hidden.add(unit);
    this.tracked.add(unit);
    (unit as HTMLElement).classList.add(HIDDEN_CLASS);
    this.applyMode(unit, rec);
  }

  /** Hard reset: removes the placeholder and the record entirely. Used for a full unhide, disabling, and "Not an ad". */
  unhide(unit: Element): void {
    const rec = this.records.get(unit);
    if (!rec) return;
    this.records.delete(unit);
    this.hidden.delete(unit);
    this.tracked.delete(unit);
    const el = unit as HTMLElement;
    el.classList.remove(HIDDEN_CLASS);
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
    if (rec.mode === 'hide') {
      el.style.setProperty('display', 'none', 'important');
    } else {
      const modeClass = this.classFor(rec.mode);
      if (modeClass) el.classList.add(modeClass);
    }
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
      const el = u as HTMLElement;
      const oldClass = this.classFor(rec.mode);
      if (oldClass) el.classList.remove(oldClass);
      this.restoreStyle(el, rec);
      rec.placeholder?.remove();
      rec.placeholder = null;
      this.applyMode(u, rec);
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

  private applyMode(unit: Element, rec: Record_): void {
    const el = unit as HTMLElement;
    rec.mode = this.mode;
    if (this.mode === 'hide') {
      // "Hide" mode is unchanged: no placeholder, the unit itself goes display:none.
      rec.prev = {
        display: el.style.getPropertyValue('display'),
        displayPriority: el.style.getPropertyPriority('display'),
      };
      el.style.setProperty('display', 'none', 'important');
      return;
    }
    rec.prev = null;
    el.classList.add(this.classFor(this.mode) as string);
    ensureUnitStylesheet(this.doc);
    rec.placeholder = this.makePlaceholder(unit, rec);
    unit.prepend(rec.placeholder);
  }

  private restoreStyle(el: HTMLElement, rec: Record_): void {
    const prev = rec.prev;
    if (!prev) return;
    if (prev.display) el.style.setProperty('display', prev.display, prev.displayPriority);
    else el.style.removeProperty('display');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }

  private labelText(rec: Record_): string {
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

  /** (Re)builds the placeholder's row for the record's current state: category, hint and shown/hidden. */
  private renderPlaceholder(rec: Record_, unit: Element): void {
    const host = rec.placeholder;
    if (!host) return;
    host.setAttribute(PLACEHOLDER_ATTR, rec.category);
    const root = host.shadowRoot;
    const row = root?.querySelector('.row');
    if (!row) return;
    while (row.firstChild) row.removeChild(row.firstChild);
    const label = this.doc.createElement('span');
    label.className = 'label';
    label.textContent = this.labelText(rec);
    row.append(label);
    if (rec.shown) {
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
