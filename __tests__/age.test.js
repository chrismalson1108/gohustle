import { parseDob, computeAge, isAdult, MIN_AGE } from '../src/lib/age';

describe('age helpers (H7 age floor)', () => {
  const NOW = new Date('2026-07-10T12:00:00Z');

  describe('parseDob', () => {
    test('parses MM/DD/YYYY and ISO to canonical ISO', () => {
      expect(parseDob('07/10/2008')).toBe('2008-07-10');
      expect(parseDob('2008-7-1')).toBe('2008-07-01');
      expect(parseDob('12/31/2000')).toBe('2000-12-31');
    });
    test('rejects impossible / malformed dates', () => {
      expect(parseDob('02/30/2005')).toBeNull();
      expect(parseDob('13/01/2005')).toBeNull();
      expect(parseDob('not a date')).toBeNull();
      expect(parseDob('')).toBeNull();
      expect(parseDob(null)).toBeNull();
      expect(parseDob('2008/07/10')).toBeNull(); // wrong separator/order
    });
  });

  describe('computeAge', () => {
    test('counts whole years, respecting the birthday boundary', () => {
      expect(computeAge('2008-07-10', NOW)).toBe(18); // exactly 18 today
      expect(computeAge('2008-07-11', NOW)).toBe(17); // birthday tomorrow → still 17
      expect(computeAge('2008-07-09', NOW)).toBe(18); // birthday was yesterday
      expect(computeAge('2000-01-01', NOW)).toBe(26);
    });
    test('accepts a Date and rejects unparseable/future DOBs', () => {
      expect(computeAge(new Date('2004-07-10'), NOW)).toBe(22);
      expect(computeAge('2030-01-01', NOW)).toBeNull(); // future
      expect(computeAge('garbage', NOW)).toBeNull();
    });
  });

  describe('isAdult', () => {
    test('blocks under-18 and admits 18+', () => {
      expect(isAdult('2008-07-11', NOW)).toBe(false); // 17
      expect(isAdult('2008-07-10', NOW)).toBe(true); // exactly 18
      expect(isAdult('2010-01-01', NOW)).toBe(false); // 16
      expect(isAdult(null, NOW)).toBe(false); // unknown → not proven adult
    });
    test('MIN_AGE is 18', () => {
      expect(MIN_AGE).toBe(18);
    });
  });
});
