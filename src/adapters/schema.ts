import { z } from 'zod';

// Site adapters are JSON config, not code, so a broken site is a one-line fix
// (BRIEF.md §5 step 1). Two deliberate extensions to the brief's shape:
//  - `hosts` is a list, because Google alone spans 19 country domains.
//  - `adSelectors` names structural ad markers (a dedicated element or attribute
//    such as Reddit's <shreddit-ad-post>). Some of these carry their label inside
//    a shadow root, where neither innerText nor querySelector can see it.
export const SuggestRuleSchema = z
  .object({
    /** Stable key for the user's per-site setting. Renaming it resets that setting. */
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    /** What the popup's switch says. */
    label: z.string().min(1),
    selectors: z.array(z.string()).default([]),
    words: z.array(z.string()).default([]),
    lineEndings: z.array(z.string()).optional(),
  })
  .strict();
export type SuggestRule = z.infer<typeof SuggestRuleSchema>;

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
  /**
   * Containers that hold only ads, often with a "Sponsored" header of their own
   * (Google's #tads). A unit inside one is hidden as the outermost container, so
   * the header goes with it. List only containers that never hold organic results.
   */
  adContainerSelector: z.string().optional(),
  /**
   * Label nodes inside an element matching this are skipped. On Instagram and
   * Threads the author name is a link, and an account called "ad" must not read
   * as a label.
   */
  labelIgnoreSelector: z.string().optional(),
  /**
   * "Suggested" posts: recommendations from accounts the user doesn't follow.
   * Off by default. `selectors` are structural markers; `words` are whole-label
   * texts matched against the label nodes (this block's own, or the adapter's).
   */
  suggested: z
    .object({
      selectors: z.array(z.string()).default([]),
      labelSelectors: z.array(z.string()).optional(),
      labelNodeLimit: z.number().int().positive().optional(),
      words: z.array(z.string()).default([]),
      /**
       * Social-proof lines that name someone first: "<Name> likes this". Checked
       * against the unit's first non-empty label only (the card's top line); a
       * line counts when it ends with a space and one of these, and is short.
       */
      lineEndings: z.array(z.string()).optional(),
      /**
       * Named kinds of suggestion the user can switch off one by one on this site
       * ("Groups you're not in", "Reels"). Each matches like the fields above, over
       * the same label nodes. The fields above stay on whenever "suggested" is.
       */
      rules: z.array(SuggestRuleSchema).default([]),
    })
    .strict()
    .optional(),
  /**
   * Whole page modules to hide under a category, outside the feed's units: X's
   * "Who to follow" box, Facebook's right-rail "Sponsored" column.
   */
  blocks: z
    .array(
      z
        .object({
          selector: z.string().min(1),
          category: z.enum(['sponsored', 'suggested']),
          /**
           * Keep only matches with no matching descendant. A selector built from
           * `:has()` also matches every ancestor of the module, up to the whole
           * column, so without this the rail's Contacts would go with its ad.
           */
          innermost: z.boolean().optional(),
          /**
           * A cheap selector (no `:has()`) that matches something inside the
           * module, such as the advertiser link. With an anchor the scanner never
           * evaluates `selector` document-wide: it finds anchors, climbs to the
           * nearest ancestor `selector` matches, and treats that as the module. A
           * mutation inside a feed post then costs nothing on this rule. Keep it
           * one compound selector with no ancestor part: the scope comes from
           * `selector` during the climb, and a query scoped to an added subtree
           * cannot see ancestors in every engine (happy-dom returns nothing).
           */
          anchor: z.string().min(1).optional(),
          /** A suggested rule's id: the module goes when that rule is switched off. */
          rule: z.string().optional(),
        })
        .strict(),
    )
    .default([]),
  feedRootSelector: z.string().optional(),
  /** Free-text provenance: when and how the selectors were last checked against the live site. */
  verified: z.string().optional(),
})
  .strict();

export type Adapter = z.infer<typeof AdapterSchema>;
