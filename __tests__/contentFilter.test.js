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
});
