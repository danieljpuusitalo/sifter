import { z } from 'zod';

// Site adapters are JSON config, not code, so a broken site is a one-line fix
// (BRIEF.md §5 step 1). Two deliberate extensions to the brief's shape:
//  - `hosts` is a list, because Google alone spans 19 country domains.
//  - `adSelectors` names structural ad markers (a dedicated element or attribute
//    such as Reddit's <shreddit-ad-post>). Some of these carry their label inside
//    a shadow root, where neither innerText nor querySelector can see it.
export const AdapterSchema = z.object({
  id: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
  unitSelector: z.string().min(1),
  textRootSelector: z.string().optional(),
  labelSelectors: z.array(z.string()).default([]),
  /**
   * Only the first N label nodes (document order) can carry a marker. Labels sit in
   * the header; on LinkedIn the same selector also matches post-body spans, and a
   * body line that is exactly "Ad" must not hide an organic post.
   */
  labelNodeLimit: z.number().int().positive().optional(),
  adSelectors: z.array(z.string()).default([]),
  feedRootSelector: z.string().optional(),
  /** Free-text provenance: when and how the selectors were last checked against the live site. */
  verified: z.string().optional(),
});

export type Adapter = z.infer<typeof AdapterSchema>;
