import { findProhibited, isClean } from '../src/lib/contentFilter';

describe('contentFilter', () => {
  test('allows normal text', () => {
    expect(findProhibited('Need help mowing my lawn this weekend')).toBeNull();
    expect(isClean('Tutoring', 'Math help for my kid')).toBe(true);
  });

  test('flags prohibited terms (whole word, case-insensitive)', () => {
    expect(findProhibited('selling COCAINE here')).toBe('cocaine');
    expect(isClean('clean listing', 'looking for an escort')).toBe(false);
  });

  test('does not flag substrings inside other words', () => {
    // "escort" should not match inside "escorted"
    expect(findProhibited('I escorted my grandma to church')).toBeNull();
  });

  test('handles empty/nullish input', () => {
    expect(findProhibited('')).toBeNull();
    expect(findProhibited(null)).toBeNull();
  });

  // Security audit: the filter must not be defeated by trivial one-character
  // evasions. These are normalized away (leetspeak / homoglyph digits + in-word
  // punctuation) before matching. Kept in lockstep with the DB backstop
  // public.contains_prohibited (migration 20260707040000).
  test('defeats leetspeak / homoglyph digit substitution', () => {
    expect(findProhibited('buying c0caine')).toBe('cocaine');
    expect(findProhibited('DM me on 0nlyfans')).toBe('onlyfans');
    expect(findProhibited('me7h for sale')).toBe('meth');
    expect(findProhibited('her0in')).toBe('heroin');
    expect(findProhibited('n1gger')).toBe('nigger');
  });

  test('defeats in-word punctuation separators', () => {
    expect(findProhibited('c.o.c.a.i.n.e please')).toBe('cocaine');
    expect(findProhibited('o-n-l-y-f-a-n-s')).toBe('onlyfans');
    expect(findProhibited('st0len g00ds')).toBe('stolen goods');
  });

  test('normalization does not introduce false positives', () => {
    // word boundaries still hold after normalization
    expect(findProhibited('I escorted my grandma to church')).toBeNull();
    expect(findProhibited('$15/hr for yard work')).toBeNull();
    expect(findProhibited('5-star tutoring, methodical approach')).toBeNull();
    expect(findProhibited('Need help this weekend, pays well')).toBeNull();
  });
});
