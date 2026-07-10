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

  // H8 (prohibited-activity-policy-gap): the blocklist now covers drugs, weapons,
  // alcohol-to-minors / fake IDs, academic (contract) cheating, and off-platform
  // payment solicitation — not just the original ~18 terms.
  test('flags expanded prohibited categories (H8)', () => {
    expect(findProhibited('selling adderall on campus')).toBe('adderall');
    expect(findProhibited('anyone got xanax')).toBe('xanax');
    expect(findProhibited('marijuana delivery run')).toBe('marijuana');
    expect(findProhibited('will trade a handgun')).toBe('handgun');
    expect(findProhibited('need ammunition, cash paid')).toBe('ammunition');
    expect(findProhibited('can you buy me alcohol')).toBe('buy me alcohol');
    expect(findProhibited('I have a fake id for sale')).toBe('fake id');
    expect(findProhibited('pay you to write my essay')).toBe('write my essay');
    expect(findProhibited('will you take my exam for me')).toBe('take my exam');
    expect(findProhibited('do my homework due tonight')).toBe('do my homework');
    expect(findProhibited("let's just settle up on venmo")).toBe('venmo');
    expect(findProhibited('pay me on cash app instead')).toBe('cash app');
  });

  test('expanded terms survive leetspeak / separator evasion (H8)', () => {
    expect(findProhibited('4dderall for sale')).toBe('adderall');
    expect(findProhibited('v-e-n-m-o me')).toBe('venmo');
    expect(findProhibited('h4ndgun')).toBe('handgun');
  });

  test('expanded terms do not over-block legitimate gigs (H8)', () => {
    // gardening / yard work must not trip the drug list ("weed" deliberately omitted)
    expect(findProhibited('help me weed the flower beds')).toBeNull();
    expect(findProhibited('pull weeds and mow the lawn')).toBeNull();
    // legitimate tutoring is not contract-cheating
    expect(findProhibited('essay tutoring and proofreading help')).toBeNull();
    expect(findProhibited('help me study for my exam')).toBeNull();
    // methodical / methodology must not match "meth"
    expect(findProhibited('a methodical, organized cleaner')).toBeNull();
  });

  test('normalization does not introduce false positives', () => {
    // word boundaries still hold after normalization
    expect(findProhibited('I escorted my grandma to church')).toBeNull();
    expect(findProhibited('$15/hr for yard work')).toBeNull();
    expect(findProhibited('5-star tutoring, methodical approach')).toBeNull();
    expect(findProhibited('Need help this weekend, pays well')).toBeNull();
  });
});
