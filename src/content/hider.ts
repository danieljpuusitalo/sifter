import type { HideCategory, HideMode } from '../types';

// Hard rule 5: never remove nodes. Hide by adding a class and inline style to the
// unit root, so infinite scroll and site JS keep working, and every hide is
// reversible in one click from the placeholder (BRIEF.md §6).

export const HIDDEN_CLASS = 'sifter-hidden';
export const PLACEHOLDER_ATTR = 'data-sifter-placeholder';

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
  placeholder: HTMLElement | null;
  prev: { display: string; displayPriority: string; filter: string; filterPriority: string; pointerEvents: string };
};

export type HiderCallbacks = {
  onShow: (unit: Element) => void;
  onNotAd: (unit: Element) => void;
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
  min-height: 28px; box-sizing: border-box; padding: 2px 12px;
  font: inherit; font-size: 13px; line-height: 1.4;
  color: currentColor; opacity: 0.65;
}
.label { flex: 1 1 auto; min-width: 0; }
button {
  all: unset; cursor: pointer; font: inherit; color: inherit;
  text-decoration: underline; text-underline-offset: 2px;
}
button:hover { opacity: 1; }
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 2px; }
`;

export class Hider {
  private records = new WeakMap<Element, Record_>();
  private hidden = new Set<Element>();

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

  hide(unit: Element, category: HideCategory): void {
    const existing = this.records.get(unit);
    if (existing) {
      if (existing.category !== category) {
        existing.category = category;
        this.updateLabel(existing, category);
      }
      return;
    }
    const el = unit as HTMLElement;
    const style = el.style;
    const rec: Record_ = {
      category,
      placeholder: null,
      prev: {
        display: style.getPropertyValue('display'),
        displayPriority: style.getPropertyPriority('display'),
        filter: style.getPropertyValue('filter'),
        filterPriority: style.getPropertyPriority('filter'),
        pointerEvents: style.getPropertyValue('pointer-events'),
      },
    };
    this.records.set(unit, rec);
    this.hidden.add(unit);
    el.classList.add(HIDDEN_CLASS);
    this.applyMode(unit, rec);
  }

  unhide(unit: Element): void {
    const rec = this.records.get(unit);
    if (!rec) return;
    this.records.delete(unit);
    this.hidden.delete(unit);
    const el = unit as HTMLElement;
    el.classList.remove(HIDDEN_CLASS);
    this.restoreStyle(el, rec);
    rec.placeholder?.remove();
  }

  unhideAll(): void {
    for (const u of [...this.hidden]) this.unhide(u);
  }

  setMode(mode: HideMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const u of this.hidden) {
      const rec = this.records.get(u);
      if (!rec) continue;
      this.restoreStyle(u as HTMLElement, rec);
      rec.placeholder?.remove();
      rec.placeholder = null;
      this.applyMode(u, rec);
    }
  }

  /**
   * Sites recycle and remove feed nodes. Drop records for units that left the
   * DOM, and re-seat placeholders that got separated from their unit.
   */
  prune(): void {
    for (const u of [...this.hidden]) {
      const rec = this.records.get(u);
      if (!u.isConnected) {
        rec?.placeholder?.remove();
        this.records.delete(u);
        this.hidden.delete(u);
      } else if (rec?.placeholder && rec.placeholder.nextElementSibling !== u) {
        u.parentNode?.insertBefore(rec.placeholder, u);
      }
    }
  }

  private applyMode(unit: Element, rec: Record_): void {
    const el = unit as HTMLElement;
    if (this.mode === 'blur') {
      el.style.setProperty('filter', 'blur(12px)', 'important');
      el.style.setProperty('pointer-events', 'none');
    } else {
      el.style.setProperty('display', 'none', 'important');
    }
    if (this.mode !== 'hide') {
      rec.placeholder = this.makePlaceholder(unit, rec.category);
      unit.parentNode?.insertBefore(rec.placeholder, unit);
    }
  }

  private restoreStyle(el: HTMLElement, rec: Record_): void {
    const { prev } = rec;
    if (prev.display) el.style.setProperty('display', prev.display, prev.displayPriority);
    else el.style.removeProperty('display');
    if (prev.filter) el.style.setProperty('filter', prev.filter, prev.filterPriority);
    else el.style.removeProperty('filter');
    if (prev.pointerEvents) el.style.setProperty('pointer-events', prev.pointerEvents);
    else el.style.removeProperty('pointer-events');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }

  private makePlaceholder(unit: Element, category: HideCategory): HTMLElement {
    const host = this.doc.createElement('div');
    host.setAttribute(PLACEHOLDER_ATTR, category);
    // Open so e2e tests can reach the buttons; nothing in it is secret. The real
    // guard against page script driving these buttons is the isTrusted check
    // below, not shadow mode: a closed root only hides the DOM from casual
    // access, and page script can already see and click host/button elements
    // it can locate by attribute regardless of shadow mode.
    const root = host.attachShadow({ mode: 'open' });
    shadowRoots.set(host, root);
    const style = this.doc.createElement('style');
    style.textContent = PLACEHOLDER_CSS;
    const row = this.doc.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'group');
    const label = this.doc.createElement('span');
    label.className = 'label';
    label.textContent = LABELS[category];
    const show = this.button('Show', 'show', () => this.cb.onShow(unit));
    const notAd = this.button(KEEP_LABELS[category], 'not-ad', () => this.cb.onNotAd(unit));
    row.append(label, show, notAd);
    root.append(style, row);
    return host;
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

  private updateLabel(rec: Record_, category: HideCategory): void {
    const label = rec.placeholder?.shadowRoot?.querySelector('.label');
    if (label) label.textContent = LABELS[category];
    const keep = rec.placeholder?.shadowRoot?.querySelector('[data-act="not-ad"]');
    if (keep) keep.textContent = KEEP_LABELS[category];
    rec.placeholder?.setAttribute(PLACEHOLDER_ATTR, category);
  }
}
