import { periodKey, isSamePeriod, livingProgress, isComplete } from '../shared/challenges.js';

// Challenges say "today" and "This Week" but nothing ever reset them, so a
// finished one read "Done · Complete!" forever. These lock in the period rules.
const daily = { id: 'c1', type: 'daily', progress: 3, target: 3 };
const weekly = { id: 'c2', type: 'weekly', progress: 100, target: 100 };

describe('periodKey', () => {
  test('daily keys change at the calendar day boundary', () => {
    expect(periodKey('daily', new Date('2026-07-30T09:00:00'))).toBe('2026-07-30');
    expect(periodKey('daily', new Date('2026-07-30T23:59:00'))).toBe('2026-07-30');
    expect(periodKey('daily', new Date('2026-07-31T00:01:00'))).toBe('2026-07-31');
  });

  test('a whole Mon-Sun week shares one weekly key', () => {
    // 2026-07-27 is a Monday.
    const mon = periodKey('weekly', new Date('2026-07-27T08:00:00'));
    for (const day of ['2026-07-27', '2026-07-29', '2026-08-02']) {
      expect(periodKey('weekly', new Date(`${day}T12:00:00`))).toBe(mon);
    }
    // The next Monday starts a new one.
    expect(periodKey('weekly', new Date('2026-08-03T00:30:00'))).not.toBe(mon);
  });

  test('weeks start Monday, so Sunday belongs to the week that just ended', () => {
    expect(periodKey('weekly', new Date('2026-08-02T23:00:00')))
      .toBe(periodKey('weekly', new Date('2026-07-27T09:00:00')));
  });

  test('an unknown type falls back to daily, never to "never resets"', () => {
    expect(periodKey('monthly', new Date('2026-07-30T09:00:00'))).toBe('2026-07-30');
  });

  test('an unparseable date is null rather than a bogus key', () => {
    expect(periodKey('daily', new Date('not a date'))).toBeNull();
  });
});

describe('isSamePeriod', () => {
  const now = new Date('2026-07-30T12:00:00');

  test('same day counts, previous day does not', () => {
    expect(isSamePeriod('daily', '2026-07-30T08:00:00', now)).toBe(true);
    expect(isSamePeriod('daily', '2026-07-29T23:59:00', now)).toBe(false);
  });

  test('a daily challenge finished yesterday is stale even hours later', () => {
    expect(isSamePeriod('daily', '2026-07-29T23:59:00', new Date('2026-07-30T00:01:00'))).toBe(false);
  });

  test('a missing timestamp is stale — old rows start fresh, not stuck', () => {
    expect(isSamePeriod('daily', null, now)).toBe(false);
    expect(isSamePeriod('daily', undefined, now)).toBe(false);
    expect(isSamePeriod('daily', '', now)).toBe(false);
  });
});

describe('livingProgress — the actual reported bug', () => {
  const now = new Date('2026-07-30T12:00:00');

  test('a daily challenge completed yesterday shows as fresh today', () => {
    expect(livingProgress(daily, '2026-07-29T18:00:00', now)).toBe(0);
  });

  test('progress made today still counts today', () => {
    expect(livingProgress(daily, '2026-07-30T09:00:00', now)).toBe(3);
  });

  test('a weekly challenge survives the day rolling over', () => {
    // Both inside the Mon 27 Jul week.
    expect(livingProgress(weekly, '2026-07-28T10:00:00', new Date('2026-07-30T10:00:00'))).toBe(100);
  });

  test('…but not the week rolling over', () => {
    expect(livingProgress(weekly, '2026-07-28T10:00:00', new Date('2026-08-04T10:00:00'))).toBe(0);
  });

  test('null challenge is 0, not a crash', () => {
    expect(livingProgress(null, '2026-07-30T09:00:00', now)).toBe(0);
  });
});

describe('isComplete', () => {
  test('at or over target is complete', () => {
    expect(isComplete({ progress: 3, target: 3 })).toBe(true);
    expect(isComplete({ progress: 4, target: 3 })).toBe(true);
  });
  test('under target is not', () => {
    expect(isComplete({ progress: 2, target: 3 })).toBe(false);
  });
  test('missing values do not throw', () => {
    expect(isComplete(null)).toBe(false);
    expect(isComplete({})).toBe(false);
  });
});
