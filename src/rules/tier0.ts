import type { MarkerHit } from '../extract';
import type { CategoryToggles, HideCategory, OverrideAction } from '../types';

// Tier 0, in order (BRIEF.md §5 step 3): user overrides, the user's own filters,
// learned selectors (M4), then marker detection. Pure, so it can be tested
// without a DOM.

export type Tier0Decision =
  | { action: 'hide'; category: HideCategory; reason: string }
  | { action: 'show'; reason: string }
  | { action: 'unknown' };

export function decideTier0(input: {
  override: OverrideAction | undefined;
  marker: MarkerHit | null;
  /** A muted word or element rule of the user's matched this unit. */
  custom?: string | null;
  categories: CategoryToggles;
}): Tier0Decision {
  if (input.override === 'not-ad') return { action: 'show', reason: 'override:not-ad' };
  if (input.override === 'hide') return { action: 'hide', category: 'manual', reason: 'override:hide' };
  if (input.custom && input.categories.custom) return { action: 'hide', category: 'custom', reason: `filter:${input.custom}` };
  if (input.marker && input.categories[input.marker.category]) {
    return { action: 'hide', category: input.marker.category, reason: `marker:${input.marker.kind}` };
  }
  return { action: 'unknown' };
}
