import type { HideCategory } from '../types';

/**
 * How a unit was presented the last time Sifter touched it: `hidden` in the page's
 * mode (collapsed, blurred or gone), `tagged` in place at full height, or `shown`
 * after the reader clicked Show.
 */
export type Presented = { state: 'hidden' | 'tagged' | 'shown'; category: HideCategory; hint?: string };

/** Enough for a long session's worth of posts, small enough to never matter. */
export const MOUNT_MEMORY_MAX = 2000;

/**
 * Mount memory (scroll stability, Phase 1). A virtualised feed unmounts a post far
 * from the screen, keeps its slot at the height the post last had, and re-creates it
 * whole when the reader comes back. A post Sifter had collapsed came back at full
 * height in a collapsed slot, wherever the pre-paint lane could not read it again:
 * a shell whose label fills in later, or a unit the lane's 1 ms cap cut, which on a
 * slow machine means one painted frame. Above the reader, that moved every post on
 * screen by the post's height.
 *
 * The site's own key for the post (an adapter's `unitKey` attribute) survives the
 * re-mount, so the lane puts the remembered presentation back before the first paint,
 * for one attribute read and no label read. `decide()` still confirms every lane hide.
 * The keys are the site's opaque ids, held in this page's memory only, never persisted.
 */
export class MountMemory {
  private map = new Map<string, Presented>();

  constructor(
    private readonly attr: string,
    private readonly max = MOUNT_MEMORY_MAX,
  ) {}

  private keyOf(unit: Element): string | null {
    return unit.getAttribute(this.attr) || null;
  }

  get(unit: Element): Presented | undefined {
    const key = this.keyOf(unit);
    return key === null ? undefined : this.map.get(key);
  }

  /** Records the unit's presentation, or forgets it (`null`: released, Not an ad). Most recent last, so the oldest goes first. */
  set(unit: Element, p: Presented | null): void {
    const key = this.keyOf(unit);
    if (key === null) return;
    this.map.delete(key);
    if (!p) return;
    this.map.set(key, p);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  /** Settings changed: what was hidden under the old ones is no longer known. */
  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
