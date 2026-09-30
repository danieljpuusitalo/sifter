import { describe, expect, it } from 'vitest';
import { zoneOf } from '../../src/content/viewport';

// The window is 720 px tall; the tracker's rootMargin grows it by 64 px each way.
const ROOT = { top: -64, bottom: 784, left: 0, right: 1280, width: 1280, height: 848, x: 0, y: -64 };

function entry(top: number, bottom: number, isIntersecting = false, rootBounds: typeof ROOT | null = ROOT, width = 600): IntersectionObserverEntry {
  const rect = { top, bottom, left: 0, right: width, width, height: bottom - top, x: 0, y: top };
  return { isIntersecting, boundingClientRect: rect, rootBounds } as unknown as IntersectionObserverEntry;
}

describe('zoneOf', () => {
  it('an intersecting unit is on screen', () => {
    expect(zoneOf(entry(100, 400, true))).toBe('in');
  });

  it('a unit wholly above or below the window is placed by it', () => {
    expect(zoneOf(entry(-900, -100))).toBe('above');
    expect(zoneOf(entry(900, 1300))).toBe('below');
  });

  // LinkedIn: the feed scrolls inside <main>, under a header. A unit scrolled up
  // behind the header is clipped, so not intersecting, while its bottom is still
  // inside the window. Calling it 'below' collapsed it at once and moved the feed.
  it('a unit clipped behind a header, still reaching into the window, is above', () => {
    expect(zoneOf(entry(-240, 60))).toBe('above');
  });

  it('a unit clipped at the bottom edge of an inner scroller is below', () => {
    expect(zoneOf(entry(700, 1000))).toBe('below');
  });

  it('a clipped unit that straddles the middle stays on screen (veiled, nothing moves)', () => {
    expect(zoneOf(entry(200, 600))).toBe('in');
  });

  it('a unit with no box is below: changing it moves nothing', () => {
    expect(zoneOf(entry(0, 0, false, ROOT, 0))).toBe('below');
  });

  it('without rootBounds, only a unit past the margin above is above', () => {
    expect(zoneOf(entry(-300, -100, false, null))).toBe('above');
    expect(zoneOf(entry(-300, 60, false, null))).toBe('below');
  });
});
