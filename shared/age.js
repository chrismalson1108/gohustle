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

function isoFromDate(dt) {
  if (isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
