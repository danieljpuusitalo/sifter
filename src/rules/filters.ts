// The user's own filters (the "custom" category): muted words and element rules.
// Both are data the user typed, so they are matched, never evaluated: words as
// whole-word text matches, rules only through querySelectorAll inside try/catch
// (hard rule 2).

import { siteKey } from '../sites';

/** Most rules and words an options page save may hold, so a paste can't stall every scan. */
export const MAX_RULES = 200;
export const MAX_WORDS = 200;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One case-insensitive pattern for all muted words, matched on word edges so
 * "cat" doesn't hide "education". Unicode-aware: \b is ASCII-only in JS, so
 * edges are "not a letter or digit" instead.
 */
export function mutedWordPattern(words: readonly string[]): RegExp | null {
  const clean = [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2))].slice(0, MAX_WORDS);
  if (clean.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${clean.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

export function mutedWordHit(text: string, pattern: RegExp | null): string | null {
  if (!pattern) return null;
  const m = pattern.exec(text);
  return m ? m[0] : null;
}

/**
 * Chrome's parser quietly closes an unfinished selector: `div:has(.x` and `[a="b`
 * are valid alone. The scanner joins every rule with ", ", and there an unclosed
 * one swallows the rules after it (`div:has(.x, .promo)` hides the parent). So a
 * rule must close its own brackets, parentheses, quotes and comments.
 */
function closed(selector: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] as string;
    if (ch === '\\') {
      // A trailing backslash has nothing to escape: unclosed, not an escape.
      if (i === selector.length - 1) return false;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '/' && selector[i + 1] === '*') return false;
    else if (ch === '(' || ch === '[') stack.push(ch === '(' ? ')' : ']');
    else if (ch === ')' || ch === ']') {
      if (stack.pop() !== ch) return false;
    }
  }
  return quote === null && stack.length === 0;
}

/** Split a selector list at its top-level commas (not inside quotes, brackets or parentheses). */
function topLevelParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] as string;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((p) => p.trim());
}

/**
 * A rule that would match most of a page: `*`, a bare tag name (`div`, `a`), or
 * anything whose subject is `html` or `body`. The scanner hides the innermost
 * match with a placeholder, so `##div` blanks every leaf of the feed and `##body`
 * the page; no user means that, and an ad blocker's filter syntax invites the
 * typo. Checked per comma-separated part, since the scanner joins rules with ", ".
 */
export function tooBroad(selector: string): boolean {
  return topLevelParts(selector).some((part) => {
    if (!part) return true;
    if (/^\*$/.test(part) || /^[a-z][a-z0-9-]*$/i.test(part)) return true;
    // The subject is the last compound: after the last combinator outside brackets.
    const subject = part.split(/[\s>+~]+(?![^([]*[)\]])/).pop() ?? '';
    return /^(html|body)(?![a-z0-9-])/i.test(subject) || subject === '*';
  });
}

export type ParsedRule = { site: string; selector: string };
export type RuleError = { line: number; text: string; reason: string };

/**
 * Parse element rules in the ad-blocker cosmetic-filter shape, one per line:
 *   linkedin.com##.some-module
 *   ##aside.sponsored          (every site Sifter runs on)
 * Lines starting with "!" are comments. `isValid` checks a selector (the options
 * page passes a querySelector-based check; tests pass happy-dom's).
 */
export function parseRules(text: string, isValid: (selector: string) => boolean): { rules: ParsedRule[]; errors: RuleError[] } {
  const rules: ParsedRule[] = [];
  const errors: RuleError[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('!')) return;
    const at = line.indexOf('##');
    if (at < 0) {
      errors.push({ line: i + 1, text: line, reason: 'needs "site##selector" (or "##selector" for every site)' });
      return;
    }
    const rawSite = line.slice(0, at).trim().toLowerCase();
    // twitter.com, google.nl etc. are stored under one key; a rule for them must be too.
    const site = rawSite ? siteKey(rawSite) : '';
    const selector = line.slice(at + 2).trim();
    if (site && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(site)) {
      errors.push({ line: i + 1, text: line, reason: `"${rawSite}" isn't a site name` });
    } else if (!selector || !closed(selector) || !isValid(selector)) {
      errors.push({ line: i + 1, text: line, reason: 'the selector is not valid CSS' });
    } else if (tooBroad(selector)) {
      errors.push({ line: i + 1, text: line, reason: 'the selector would hide most of the page (a bare tag, *, html or body)' });
    } else if (rules.length >= MAX_RULES) {
      errors.push({ line: i + 1, text: line, reason: `more than ${MAX_RULES} rules` });
    } else {
      rules.push({ site, selector });
    }
  });
  return { rules, errors };
}

/** The selectors that apply on one site: its own rules plus the every-site ones. */
export function selectorsFor(rules: readonly ParsedRule[], siteKey: string): string[] {
  return rules.filter((r) => r.site === '' || r.site === siteKey || siteKey.endsWith(`.${r.site}`)).map((r) => r.selector);
}
