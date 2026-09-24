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
  const stable = stableText(text);
  return `${stable.length}:${cyrb53(stable).toString(36)}`;
}

export function fingerprint(host: string, text: string): string {
  const norm = stableText(text).slice(0, 500);
  return cyrb53(`${host}\n${norm}`).toString(36);
}
