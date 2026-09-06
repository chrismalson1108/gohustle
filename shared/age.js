// Age-floor helpers (H7). GoHustlr arranges in-person meetings and includes a
// minor-adjacent student population, so we collect a real date of birth and enforce a
// minimum age of 18 at action time — a floor, not full identity verification.
//
// Cross-platform (mobile re-exports via src/lib/age.js; web imports from
// @gohustlr/shared). Pure and dependency-free so it is unit-testable. The
// authoritative block is server-side (guard_min_age trigger, migration
// 20260710040000_age_floor.sql); this powers the client UX on both platforms.

export const MIN_AGE = 18;

// Parse a user-entered DOB into a canonical 'YYYY-MM-DD' string, or null if invalid.
// Accepts 'MM/DD/YYYY' (US, what the input hints) and 'YYYY-MM-DD' (ISO).
export function parseDob(input) {
  if (input == null) return null;
  const s = String(input).trim();
  let y, m, d;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, y, m, d] = match;
  } else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    [, m, d, y] = match;
  } else {
    return null;
  }
  y = Number(y); m = Number(m); d = Number(d);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible dates (e.g. 02/30) by round-tripping through Date (UTC to avoid
  // TZ drift), and require a sane year range.
  if (y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

// Whole years old on `now` (default today). Accepts a Date or 'YYYY-MM-DD'/'MM/DD/YYYY'
// string. Returns null if the DOB can't be parsed or is in the future.
// See isoFromDate for how a Date is read — it is not simply local time, and it must not be.
export function computeAge(dob, now = new Date()) {
  let iso = dob instanceof Date ? isoFromDate(dob) : parseDob(dob);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const today = now instanceof Date ? now : new Date(now);
  let age = today.getFullYear() - y;
  const beforeBirthday =
    today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d);
  if (beforeBirthday) age -= 1;
  if (age < 0) return null;
  return age;
}

export function isAdult(dob, now = new Date()) {
  const age = computeAge(dob, now);
  return age != null && age >= MIN_AGE;
}

// Which calendar day does this Date denote? A Date is an instant, not a day, so there is
// no single reading — and BOTH naive answers are wrong half the world:
//
//   new Date('2008-07-11')  is UTC midnight. Read with LOCAL getters it renders as 10
//                           July everywhere WEST of UTC, so the DOB lands a day early
//                           and isAdult() admits a 17-year-old on the eve of their
//                           birthday. This is the bug this function shipped with.
//   new Date(2008, 6, 11)   is LOCAL midnight — what a native date picker hands you.
//                           Read with UTC getters it renders as 10 July everywhere EAST
//                           of UTC: the exact mirror of the same bug. So "just use the
//                           UTC getters" is not the fix.
//
// Read the value the way it was written instead. A Date sitting exactly on UTC midnight
// is a date-only value — that is what both `new Date('YYYY-MM-DD')` and `Date.UTC(...)`
// produce — and is read in UTC; anything carrying a time-of-day is a local instant and is
// read locally. The one residual ambiguity is a local Date whose time-of-day happens to
// fall on UTC midnight (19:00 in Chicago, say); a DOB never carries a wall-clock time, so
// that shape does not arise here.
function isoFromDate(dt) {
  if (!(dt instanceof Date) || isNaN(dt.getTime())) return null;
  const dateOnly =
    dt.getUTCHours() === 0 &&
    dt.getUTCMinutes() === 0 &&
    dt.getUTCSeconds() === 0 &&
    dt.getUTCMilliseconds() === 0;
  const y = dateOnly ? dt.getUTCFullYear() : dt.getFullYear();
  const m = dateOnly ? dt.getUTCMonth() : dt.getMonth();
  const d = dateOnly ? dt.getUTCDate() : dt.getDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
