/**
 * The date stamped on an expense or an income entry is the USER's date.
 *
 * Every Add-expense / Add-income sheet, and EarnScreen's auto-logged gig drive, took
 * their default from `new Date().toISOString().slice(0, 10)` — the UTC calendar date.
 * The market is US college students: from about 7pm Eastern (4pm Pacific) the UTC date
 * is already tomorrow, so an evening receipt was dated the following day. `expenses
 * .date` is a DATE column and the Tax Center's year filter, per-job grouping and
 * year-end CSV all read it, while the YEAR they are scoped to comes from the local
 * clock — so the two disagreed, and a 31 December evening entry filed itself into the
 * next tax year.
 */
const fs = require('fs');
const path = require('path');

const { localDateISO } = require('../shared/taxFormat.js');

// The shipped-and-wrong helper, kept inline so the discrimination is visible.
const OLD_todayISO = (d) => d.toISOString().slice(0, 10);

describe('localDateISO', () => {
  // Everything here is built from LOCAL components, so the assertions hold whatever
  // zone the suite runs in — the point of the fix is exactly that the answer follows
  // the user's clock rather than the runner's.
  test("9:15pm on New Year's Eve is 31 December, wherever you are", () => {
    expect(localDateISO(new Date(2026, 11, 31, 21, 15))).toBe('2026-12-31');
    expect(localDateISO(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
  });

  test('the old UTC helper files that same entry into the NEXT tax year', () => {
    const nye = new Date(2026, 11, 31, 21, 15); // 9:15pm on the user's own clock
    // 165 minutes is the gap to midnight; every American zone is well past it, and
    // that is the whole market. Guarded rather than assumed, so a UTC runner is not a
    // false failure.
    if (nye.getTimezoneOffset() >= 180) {
      expect(OLD_todayISO(nye)).toBe('2027-01-01');
      expect(localDateISO(nye)).not.toBe(OLD_todayISO(nye));
    }
    // And the arithmetic with no dependence on the runner at all: the old helper is
    // the UTC date by construction, so 03:15 UTC on 1 January is all it can see.
    expect(OLD_todayISO(new Date(Date.UTC(2027, 0, 1, 3, 15)))).toBe('2027-01-01');
  });

  test('agrees with the UTC helper for a mid-day entry', () => {
    const noon = new Date('2026-06-04T12:00:00Z');
    expect(localDateISO(noon)).toBe(OLD_todayISO(noon));
  });

  test('is the local calendar date the year filter reads', () => {
    // The Tax Center scopes by `new Date().getFullYear()` and `date.startsWith(year)`.
    const now = new Date();
    expect(localDateISO(now).slice(0, 4)).toBe(String(now.getFullYear()));
    expect(localDateISO()).toBe(localDateISO(new Date()));
  });

  test('pads month and day, and returns null rather than a bogus date', () => {
    expect(localDateISO(new Date(2026, 0, 5, 9, 0))).toBe('2026-01-05');
    expect(localDateISO('not a date')).toBeNull();
  });
});

describe('no screen prefills a UTC date', () => {
  const FILES = [
    'src/screens/ExpensesScreen.js',
    'src/screens/EarnScreen.js',
    'web/app/(app)/profile/taxes/page.tsx',
    'web/components/TrackExpensesModal.tsx',
  ];

  test.each(FILES)('%s builds today from the local clock', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/todayISO = \(\) => localDateISO\(\)/);
    expect(code).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/);
  });
});
