// Shared data shapes. See BRIEF.md §5 "Data shapes".

export type UnitPayload = {
  id: string; // short batch-local id, e.g. "u7"
  text: string; // innerText, whitespace collapsed, max 600 chars
  labels: string[]; // short header/byline texts, max 5 x 40 chars
  linkHosts: string[]; // unique outbound hostnames, max 5
  hasCta: boolean; // "Shop now", "Learn more", "Install", "Sign up" style controls
};

export type Category = 'sponsored' | 'affiliate' | 'custom' | 'none';

export type Verdict = {
  id: string;
  category: Category;
  filterId?: string;
  confidence: number;
};

/** A category a unit can be hidden under. "manual" is the user's own "Hide this". */
export type HideCategory = Exclude<Category, 'none'> | 'manual';

export type OverrideAction = 'not-ad' | 'hide';

export type HideMode = 'collapse' | 'blur' | 'hide';
