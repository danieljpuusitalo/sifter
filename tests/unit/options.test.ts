import { describe, expect, it } from 'vitest';
import { parseWords } from '../../entrypoints/options/App.tsx';
import { MAX_WORD_LEN } from '../../src/storage/settings';

// The audit's items 3 and 4: an over-length or too-short muted word must be
// reported, not silently dropped (over-length used to vanish only on the next
// load, once the storage schema's own cap ran).

describe('parseWords', () => {
  it('keeps valid words, one per line or comma-separated', () => {
    const { words, errors } = parseWords('crypto\nweight loss, giveaway');
    expect(words).toEqual(['crypto', 'weight loss', 'giveaway']);
    expect(errors).toEqual([]);
  });

  it('reports a too-short word instead of dropping it silently', () => {
    const { words, errors } = parseWords('a\ncrypto');
    expect(words).toEqual(['crypto']);
    expect(errors).toEqual([{ line: 1, text: 'a', reason: "'a' is too short to be a muted word" }]);
  });

  it('reports an over-length word (the same cap the storage schema enforces)', () => {
    const long = 'x'.repeat(MAX_WORD_LEN + 1);
    const { words, errors } = parseWords(`${long}\ncrypto`);
    expect(words).toEqual(['crypto']);
    expect(errors).toEqual([{ line: 1, text: long, reason: `'${long}' is longer than ${MAX_WORD_LEN} characters` }]);
  });

  it('keeps a word at exactly the cap', () => {
    const atCap = 'x'.repeat(MAX_WORD_LEN);
    const { words, errors } = parseWords(atCap);
    expect(words).toEqual([atCap]);
    expect(errors).toEqual([]);
  });

  it('drops duplicates case-insensitively, without an error', () => {
    const { words, errors } = parseWords('Crypto\ncrypto');
    expect(words).toEqual(['Crypto']);
    expect(errors).toEqual([]);
  });

  it('reports the textarea line, not the comma-split position', () => {
    const { errors } = parseWords('crypto\na, giveaway');
    expect(errors).toEqual([{ line: 2, text: 'a', reason: "'a' is too short to be a muted word" }]);
  });
});
