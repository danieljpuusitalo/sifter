# Sifter: how to build it so it lasts

Written 2026-09-24, after M0 and M1. This is a proposal. It does not change
`BRIEF.md` until Daniel approves the roadmap in section 8. Where it contradicts a
hard rule, it says so and leaves the decision open.

## 1. The thesis in one paragraph

Every generation of ad blocking has attacked the ad's **plumbing**, and every
generation of advertising has since moved its plumbing somewhere the blocker can't
reach:

- Network lists blocked ad servers, so ads moved first-party and native into the feed.
- Cosmetic filters matched ad classes, so class names became randomised.
- YouTube is now stitching ads into the video stream on the server.
- ChatGPT is generating ads inside the answer.

The one thing that has not moved, and cannot, is the **disclosure**. EU law (DSA
Art. 26) requires every ad on an online platform to be identifiable as an ad "in a
clear, concise and unambiguous manner and in real time". US endorsement rules push
the same way. A platform can hide its plumbing from a machine. It cannot hide the
label from a human without breaking the law. **Sifter should detect what the law
forces a human to see, not how the page was built.** Everything below follows from
that. The line to remember: *you can obfuscate a label from the DOM, but not from
the retina.*

## 2. What is changing, and what it means for Sifter

| Shift | Evidence | Consequence |
|---|---|---|
| Ads inside AI answers | ChatGPT ads: US pilot on 2026-02-09, self-serve on 2026-05-05, 31 European countries (NL included) from late August 2026. Labelled sponsored cards sit below the answer, and "Sponsored Agents" were announced on 2026-09-16 ([tech-insider](https://tech-insider.org/chatgpt-ads-rollout-2026/), [arwriterai](https://arwriterai.com/en/blog/openai-sponsored-agents-chatgpt-ads-2026/)) | This is the fastest-growing ad surface, and no network list touches it. The cards are *labelled*, so a disclosure detector covers them on day one. `chatgpt.com` should be a launch site, not "later". |
| Server-side ad insertion | YouTube has been testing ads stitched into the stream, which breaks request blocking and timestamp tools like SponsorBlock ([BleepingComputer](https://www.bleepingcomputer.com/news/google/youtube-tests-harder-to-block-server-side-ad-injection-in-videos/), [AdGuard](https://adguard.com/en/blog/youtube-server-side-ad-insertion.html)) | The player still has to *show* that an ad is playing (a badge, a countdown, a skip button). Detecting that rendered state is the only approach that survives SSAI. Horizon item, see §6. |
| Free local models in the browser | Chrome's Prompt API (Gemini Nano) is stable for extensions and usable from the service worker since Chrome 138. It accepts image input from Chrome 148 ([Chrome docs](https://developer.chrome.com/docs/ai/prompt-api)) | A classifier that costs nothing per call and sends nothing off the device. With image input, it can *look at* a label, not just read it. |
| Legally mandated disclosure | DSA Art. 26, in force since 2024-02-16: ads must be identifiable as ads in real time, along with the advertiser, the payer and the main targeting parameters ([CMS](https://www.cms-digitallaws.com/en/dsa/article-26/), [EU DSA text](https://www.eu-digital-services-act.com/Digital_Services_Act_Article_26.html)) | This is a stable detection target that platforms are legally barred from removing. Tier 0 already exploits it. The upgrade is to exploit it *through perception* (§4.1). |
| Others trying LLM blocking | AdGuard has published LLM ad-blocking prototypes ([AdGuard](https://adguard.com/en/blog/beyond-filter-lists-rethinking-ad-blocking-with-llms.html)). An "LLM Ad Blocker" for chatbot answers was **removed from the Chrome Web Store on 2026-06-12 for a policy violation** ([Web Store](https://chromewebstore.google.com/detail/llm-ad-blocker/adlghoabcpmomlommpcemnobcpinjcgi), [chrome-stats](https://chrome-stats.com/d/adlghoabcpmomlommpcemnobcpinjcgi)) | The idea "an LLM reads the page" is not a moat, and store policy is a real risk (§7). The moat is the architecture: local, precision-verified, self-distilling, zero-infra. |

## 3. Design principles

1. **Detect the disclosure, not the plumbing.** Adapters become hints that make
   Sifter faster. They are not what makes it correct. A generic disclosure detector
   must stand alone on a site Sifter has never seen.
2. **Perceive like a human.** Judge only the rendered text and geometry a person
   would see, never the raw DOM text. Decoy letters, CSS reordering and hidden spans
   are the platforms' tools; perception makes them useless.
3. **Free first, then cheaper with use.** Every verdict an expensive tier makes is
   distilled into something a cheaper tier can reuse. The cost per page should trend
   towards zero on the sites a user actually visits.
4. **Verified evidence, not model opinion.** A model may *propose* a hide. It
   happens only when the model cites evidence Sifter can check against what is
   actually rendered.
5. **Zero infrastructure, forever.** No server to pay for, go down or be subpoenaed.
   Distribution is the Web Store, and hosting is GitHub. Automation runs on the
   developer's side, not the user's.

## 4. Architecture

### 4.1 Perception layer (new; the core innovation)

Today's extractor reads `innerText` from label nodes. That is already better than
`textContent`, but it is still the DOM's account of the page. The perception layer
reconstructs **what is on screen**:

- **Rendered-text reconstruction.** For a unit's header region, walk its text nodes,
  take each glyph run's box via `Range.getClientRects()`, and drop any run that:
  - has zero area
  - is clipped by an ancestor
  - is transparent (`opacity`, or `color` equal to the background)
  - sits off-screen (`clip`, `text-indent`)

  Then order what is left by position, not by DOM order. "Sp", decoy "x", "on",
  "sored" absolutely positioned becomes "Sponsored". CSS `order` tricks reverse
  themselves. Cost: a handful of rect calls, on header regions only, inside the
  existing 8 ms slices.
- **The accessibility channel.** Visible labels are usually mirrored in
  `aria-label`, `aria-labelledby` and `aria-describedby`, and an obfuscated label
  often keeps a clean accessible name, because otherwise screen-reader users would
  lose the disclosure. Read it as a second, independent signal.

  Caveat: this is a hypothesis to test on real captures. Extensions can't read the
  browser's computed accessibility tree on desktop Chrome, only the ARIA attributes
  in the DOM.
- **Pixel fallback (endgame).** When both text channels are ambiguous and a model
  tier is already needed, crop the unit's header from `captureVisibleTab`. On Chrome
  148+, ask Nano, which takes image input, whether it shows an ad disclosure. This
  is the channel a platform cannot defeat without also defeating the human, which
  the law forbids. Cost: an extra permission (`activeTab` is not enough for
  background captures) and an on-screen-only constraint. Opt-in.

Result: a `Perception` record per unit, `{ renderedHeader, a11yNames, disclosure:
{ text, channel, rect } | null }`. Tiers downstream consume it instead of raw text.

### 4.2 The judgement cascade (the brief's tiers, re-cut by cost)

| Tier | What | Cost | Latency | Where |
|---|---|---|---|---|
| T0 | Overrides, disclosure markers over *perceived* text, ad-click hosts | 0 | microseconds | content script |
| T1 | Distilled local rules: learned selectors *and* learned label shapes | 0 | microseconds, pre-paint CSS | content script, `document_start` |
| T2 | Gemini Nano via the Prompt API (text, then image crop) | 0 | ~100 ms to 1 s | service worker |
| T3 | Bring-your-own-key cloud (Haiku 4.5 by default), capped daily budget | cents per day | ~1 s | service worker |

Each tier only sees what the tier below could not decide. The brief already defines
T0, T2/T3 and learned selectors. What is new is the ordering principle (cost, not
technique) and the next two sections.

### 4.3 Verified-evidence rule (precision guard)

The verdict schema gains a required `evidence` field: the exact disclosure string
the model claims to see, or, for a custom filter, the exact phrase that triggered
it. The service worker hides only if that string appears in the unit's *perceived*
text. A hallucinated "Sponsored" can't hide a friend's post, because Sifter checks
the quote against the screen.

This turns hard rule 6 (precision over recall) from a threshold into a proof
obligation. It also makes a weaker local model safe to use by default.

### 4.4 Distillation loop (gets cheaper with use)

The brief's M4 learned selectors, generalised:

1. A T2 or T3 verdict with verified evidence proposes a **rule**: either a
   structural selector (as in the brief) or a **label shape** such as "on this host,
   a header whose perceived text ends in `· Promoted`".
2. The candidate is validated locally against the current page. It must match every
   unit judged sponsored and none of at least 10 units judged organic, as in the
   brief.
3. It is promoted to T1. The next visit hides those units pre-paint with zero model
   calls. This is the brief's M4 acceptance test.
4. **Every "Not an ad" click is a negative example.** It demotes the rule that fired
   and joins the validation set. The user's corrections are the training data, and
   they never leave the browser.

On the sites a person visits daily, T2/T3 calls should approach zero after a few
days. That can be measured locally and shown in the popup ("98% of hides today cost
nothing").

### 4.5 Compile, don't interpret: plain-English filters

A custom filter like "hide 'comment PDF and I'll DM you' posts" should not run an
LLM on every unit forever. Treat it as **source code for a classifier**:

- **Compile once** (T3 if a key exists, else T2). The model turns the sentence into
  `{ prefilter: keyword/regex set, prompt: short classification instruction,
  examples: 3 positives, 3 negatives }`. The output is data (hard rule 2), shown to
  the user for approval, and editable.
- **Run cheaply.** The prefilter runs in T0 for free and discards most units. Only
  prefilter hits go to Nano with the compiled prompt. The evidence rule applies.
- **Recompile on corrections.** Enough "Not an ad"-style corrections trigger a
  recompile proposal.

This makes custom filters practical on the free tier, which the brief currently
doubts (§11, on-device quality).

### 4.6 Drift self-diagnosis (self-healing without telemetry)

Each adapter carries expectations: the unit count per viewport and the typical
disclosure rate. The content script compares the live page against them locally.

- When the adapter's selector finds zero units but the generic detector finds
  disclosures, the adapter is broken and generic mode takes over automatically.
- The popup shows this plainly: "LinkedIn layout changed; running in generic mode".
- A dev build adds a **Capture fixture** button: it saves a sanitised snapshot to
  `fixtures/private/` (personal text scrubbed, `data-gold` pre-filled from current
  verdicts).

Nothing is sent anywhere. The user sees the degradation. The developer sees it by
using the product.

### 4.7 Automation on the developer side (free)

- **CI (GitHub Actions, free on public repos):** verify + e2e on every push, as
  today.
- **Adapter repair loop:** a captured fixture plus a failing eval is a complete,
  self-contained task. A Claude Code session is pointed at it ("the eval fails on
  this capture; fix the adapter JSON until `pnpm verify` is green") and opens a PR.
  Because adapters are JSON and the evals are the oracle, this can run with little
  supervision under the operating layer's autonomy rules.
- **Release:** adapter fixes ship as an extension update through the Web Store, so
  there is no remote config and hard rule 1 holds.
- **Hosting:** the privacy policy and landing page live on GitHub Pages.
- **Total cost:** the one-time $5 Web Store fee. Edge Add-ons is free.

## 5. What makes this not "another ad blocker"

- It works where blockers structurally can't: first-party native units, AI answers,
  and, via rendered state, server-stitched video.
- It is **complementary**. It runs alongside uBlock Origin Lite or Brave, never
  blocks a request, and never fights a site's anti-adblock script, because nothing
  fails to load.
- It is **regulation-anchored**. Its main signal is one the platforms are legally
  required to keep rendering.
- It **learns locally and gets cheaper**. There's no filter-list maintainer, no
  server and no telemetry. The user's own corrections train it.
- It extends naturally from "ads" to an **attention policy**: engagement bait,
  undisclosed affiliate links, "comment KEYWORD" funnels, AI answer sponsorships.
  These are things a person wants filtered that no ad blocker will ever list.

## 6. New surfaces, in order of readiness

1. **AI answers (ready now).** Adapters for chatgpt.com sponsored cards and Google
   AI Mode ads, plus the generic disclosure detector for Perplexity and others. The
   cards are labelled, so T0 plus perception covers them. Sponsored Agents need a
   capture to know how they render. This is the headline for the store listing: *the
   first blocker for ads inside AI answers*. The removed "LLM Ad Blocker" shows there
   is demand; being careful about the store policy it tripped is the lesson.
2. **Undisclosed commercial intent (annotate, don't hide).** Affiliate parameters
   (`tag=`, `ref=`, known affiliate redirect hosts), discount-code patterns, and
   "comment X to get Y" funnels. Precision rules say the default is a small chip
   ("affiliate link") rather than a hide. Users can promote a chip to a hide per
   category.
3. **Video under SSAI (horizon).** Detect the player's rendered ad state (badge,
   countdown, "Sponsored" chip) and apply a reversible treatment: mute and dim, with
   a one-click "show". Never skip or seek. This keeps Sifter out of the anti-adblock
   arms race, and it is honest about what a client can do with a stitched stream.
   Needs a legal and store-policy read first.
4. **Agents (horizon).** When an AI agent browses for the user, sponsored results
   bias its choices. Sifter's per-unit verdicts could be exposed to the user's own
   agent as a local "this unit is a disclosed ad" signal, a filter for content read
   by AI agents, which the brief already lists under "Later". Wait until the
   agent-browser APIs settle.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Web Store policy (the precedent above was removed; the cause isn't public) | Single-purpose statement, narrow required permissions with optional ones requested at use, no remote code, and a published privacy policy. Read the current policies before M5 and look for the removed extension's stated reason. |
| **Name collision:** "Sifter" already exists on the Web Store (a web highlighter), and "Sift" is also taken ([Sifter](https://chromewebstore.google.com/detail/sifter/bebodpkbnglejbdlmbmkllkpgambldld), [Sift](https://chromewebstore.google.com/detail/sift/dlfkfjinlidemapbaldjfiaplodcdidl), [GitHub Sifter-Extension](https://github.com/jmsundin/Sifter-Extension)) | Not a blocker (store names aren't unique), but it hurts search and could confuse. Decide before M5; a distinctive store title such as "Sifter: ads inside the feed and AI answers" may be enough. |
| Nano availability is hardware-gated, and Windows on ARM support is unverified | Probe `LanguageModel.availability()` on Daniel's machine as the first task of M2. Labels-only mode and bring-your-own-key remain full fallbacks. |
| Platforms obfuscate labels against machines | Perception (§4.1). The pixel fallback is the floor they can't go below legally. |
| Pre-paint hiding vs "reversible in one click" | Learned CSS hides before paint, when no placeholder exists yet. Inject the placeholder as soon as the node is seen, so undo is still one click. Needs a check that the undo holds when the unit never painted. |

## 8. Proposed roadmap change (needs Daniel's approval)

The brief goes M2 model → M3 filters → M4 learned rules → M5 ship. Proposed:

| Milestone | Change from the brief |
|---|---|
| **M1.5 Perception** (new, no model) | Rendered-text reconstruction plus the ARIA channel and `Perception` records. Adversarial fixtures: decoy spans, CSS reordering, transparent letters, split labels. Done when those fixtures pass with fp=0 and the existing evals stay green. |
| M2 Model tier | Adds the `evidence` field and the verified-evidence gate. Nano availability is probed on this machine first. Otherwise as the brief. |
| M3 Filters | Filters become *compiled* (§4.5). Done when the brief's "comment a keyword" fixture passes with most units never reaching the model (assert on the mock call count). |
| M4 Distillation | The brief's learned selectors plus label shapes, with corrections as negatives. Adds drift self-diagnosis (§4.6) and the Capture fixture button. |
| M5 Ship | Adds a `chatgpt.com` adapter (from a real capture) to the launch sites. YouTube narrows to the home and search grids, as in the brief. |
| Later | The pixel fallback, the video treatment, commercial-intent chips, and agent signals. |

## 9. Decisions only Daniel can make

1. Approve, amend or reject the roadmap in §8.
2. **Community rule packs.** A shared learned-rules list published as static JSON
   (brief §12) would be fetched from GitHub. That is remote *data*, not code, but it
   conflicts with hard rule 1 ("no remote config"). Options: keep the rule as it is
   and ship rules only in updates (current plan), or amend it to allow one signed,
   static, opt-in file.
3. The name and store title (see §7).
4. Whether the pixel fallback's extra permission is acceptable, even as opt-in.
5. Whether to create the GitHub repo now (private until M5) so CI runs.
