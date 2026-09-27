// Fingerprint = hash of host + normalised text (BRIEF.md §5 step 2). Used for the
// verdict cache, user overrides and dedupe. Synchronous on purpose: it runs on the
// content script's hot path, where crypto.subtle's async digest would force a
// microtask per unit.

export function normaliseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** cyrb53: fast, well-distributed 53-bit string hash. Not cryptographic; it doesn't need to be. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Feeds rewrite numbers in place all the time: reaction counts, "3m" ago, view
 * counts. A fingerprint that includes them stops matching the user's "Not an ad"
 * the moment a like arrives, so every digit run (with its separators and a short
 * unit such as K, h or hrs) collapses to one symbol before hashing.
 */
export function stableText(text: string): string {
  return normaliseText(text).replace(/\d[\d.,]*(?:\s?[a-zA-Z]{1,3}\b)?/g, '#');
}

/**
 * Cheap change signal for a unit's raw textContent: the scanner re-decides a unit
 * only when this moves. Digit runs collapse for the same reason as above, so a
 * ticking like count (rewritten in place twice a second on a live feed) does not
 * cost a full decision, with its computed-style reads, on every scan.
 */
export function changeSignature(text: string): string {
  // One pass, no intermediate strings: equal to hashing stableText(text), but the
  // two regex passes over a whole post's textContent were the third-largest cost
  // of a rescan on live LinkedIn (bench/live.ts --profile). tests/unit pin the
  // equality against stableText.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let len = 0;
  const push = (ch: number) => {
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    len++;
  };
  const n = text.length;
  let space = false; // a whitespace run is pending: emit one space before the next char
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) {
      space = true;
      i++;
      continue;
    }
    if (space && len > 0) push(32);
    space = false;
    if (c < 48 || c > 57) {
      push(c);
      i++;
      continue;
    }
    // \d[\d.,]*(?:\s?[a-zA-Z]{1,3}\b)?  ->  '#'
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (!((d >= 48 && d <= 57) || d === 46 || d === 44)) break;
      j++;
    }
    let k = j;
    while (k < n && isSpace(text.charCodeAt(k))) k++;
    let m = k;
    while (m < n && m - k < 4 && isLetter(text.charCodeAt(m))) m++;
    const letters = m - k;
    if (letters >= 1 && letters <= 3 && (m >= n || !isWord(text.charCodeAt(m)))) j = m;
    push(35);
    i = j;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${len}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** JavaScript's `\s`, by char code. */
function isSpace(c: number): boolean {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** JavaScript's `\w`, for `\b`. */
function isWord(c: number): boolean {
  return isLetter(c) || (c >= 48 && c <= 57) || c === 95;
}

export function fingerprint(host: string, text: string): string {
  const norm = stableText(text).slice(0, 500);
  return cyrb53(`${host}\n${norm}`).toString(36);
}
