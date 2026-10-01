import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepInPlace } from '../../src/content/anchor';

// A release pass (pause, a switch turned off) must not move the post the reader is
// looking at. happy-dom has no layout, so the test lays the page out by hand: each
// post's top is the sum of the heights above it, and "releasing" a post grows it.

const heights = new Map<Element, number>();
let scrolled: number[];
let scrollTop: number;

function layout(): Element[] {
  return [...document.querySelectorAll('.post')];
}
function topOf(el: Element): number {
  let y = -scrollTop;
  for (const p of layout()) {
    if (p === el) return y;
    y += heights.get(p)!;
  }
  return y;
}

beforeEach(() => {
  document.body.innerHTML = ['a', 'b', 'c', 'd', 'e'].map((id) => `<div class="post" id="${id}"><p>Post ${id}</p></div>`).join('');
  scrolled = [];
  scrollTop = 400;
  // Two collapsed posts above the screen (a, b), the reader on c.
  for (const p of layout()) heights.set(p, p.id === 'a' || p.id === 'b' ? 36 : 400);
  for (const p of layout()) {
    p.getBoundingClientRect = () => ({ top: topOf(p), bottom: topOf(p) + heights.get(p)!, left: 0, right: 600, width: 600, height: heights.get(p)! }) as DOMRect;
  }
  // The probe hits whatever post spans that height.
  document.elementFromPoint = (_x: number, y: number) => layout().find((p) => topOf(p) <= y && y < topOf(p) + heights.get(p)!)?.querySelector('p') ?? null;
  vi.spyOn(window, 'scrollBy').mockImplementation(((o: ScrollToOptions) => {
    scrolled.push(o.top ?? 0);
    scrollTop += o.top ?? 0;
  }) as typeof window.scrollBy);
});
afterEach(() => vi.restoreAllMocks());

const isPost = (el: Element) => el.classList.contains('post');
const release = (...ids: string[]) => () => {
  for (const id of ids) heights.set(document.getElementById(id)!, 400);
};

describe('keepInPlace', () => {
  it('posts released above the screen do not move the post on screen', () => {
    const c = document.getElementById('c')!;
    const before = c.getBoundingClientRect().top;
    const delta = keepInPlace(document, isPost, release('a', 'b'));
    expect(delta, 'positive control: the release moved the post').toBe(728);
    expect(scrolled).toEqual([728]);
    expect(c.getBoundingClientRect().top).toBe(before);
  });

  it('a release below the reader needs no correction', () => {
    heights.set(document.getElementById('e')!, 36);
    expect(keepInPlace(document, isPost, release('e'))).toBe(0);
    expect(scrolled).toEqual([]);
  });

  it('negative control: without an anchor nothing scrolls, and the post moves', () => {
    const c = document.getElementById('c')!;
    const before = c.getBoundingClientRect().top;
    expect(keepInPlace(document, () => false, release('a', 'b'))).toBe(0);
    expect(scrolled).toEqual([]);
    expect(c.getBoundingClientRect().top).toBe(before + 728);
  });

  it('runs the writes even when the page has no elementFromPoint', () => {
    const writes = vi.fn();
    Object.defineProperty(document, 'elementFromPoint', { value: undefined, configurable: true });
    expect(keepInPlace(document, isPost, writes)).toBe(0);
    expect(writes).toHaveBeenCalledOnce();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });
});
