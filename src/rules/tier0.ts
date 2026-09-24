import type { MarkerHit } from '../extract';
import type { HideCategory, OverrideAction } from '../types';

// Tier 0, in order (BRIEF.md §5 step 3): user overrides, learned selectors (M4),
// then marker detection. Pure, so it can be tested without a DOM.

export type Tier0Decision =
  | { action: 'hide'; category: HideCategory; reason: string }
  | { action: 'show'; reason: string }
  | { action: 'unknown' };

export function decideTier0(input: { override: OverrideAction | undefined; marker: MarkerHit | null }): Tier0Decision {
  if (input.override === 'not-ad') return { action: 'show', reason: 'override:not-ad' };
  if (input.override === 'hide') return { action: 'hide', category: 'manual', reason: 'override:hide' };
  if (input.marker) return { action: 'hide', category: 'sponsored', reason: `marker:${input.marker.kind}` };
  return { action: 'unknown' };
}
