// Pure availability / schedule helpers (no native imports, unit-testable). Used
// by mobile, web, and the AI assistant to reason about when a student can work.
//
// Data shapes:
//   availability: array of { day: 0-6 (0=Sun), start: 'HH:MM', end: 'HH:MM' }
//   classSchedule: array of { days: number[], start_time: 'HH:MM', end_time: 'HH:MM', title }

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const WORK_STATUSES = [
  { id: 'available', label: 'Ready to work', emoji: '🟢', color: '#10B981' },
  { id: 'busy', label: 'Busy', emoji: '🟠', color: '#F59E0B' },
  { id: 'away', label: 'Away', emoji: '🔴', color: '#EF4444' },
  { id: 'offline', label: 'Offline', emoji: '⚪', color: '#9CA3AF' },
];

// Named workStatusMeta (not statusMeta) to avoid colliding with lifecycle.js's
// booking-status helper in the shared barrel.
export function workStatusMeta(id) {
  return WORK_STATUSES.find((s) => s.id === id) || WORK_STATUSES[0];
}

// 'HH:MM' → minutes since midnight (or null if malformed).
export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// 'HH:MM' → friendly '3pm' / '3:30pm'.
export function fmtTime(hhmm) {
  const mins = parseTime(hhmm);
  if (mins == null) return '';
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// The user's declared free windows on a given weekday.
export function windowsForDay(availability = [], day) {
  return (availability || []).filter((w) => Number(w.day) === Number(day));
}

// Does a class block overlap the given { day, start, end }?
export function classOverlaps(classSchedule = [], { day, start, end } = {}) {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s == null || e == null) return false;
  return (classSchedule || []).some((c) => {
    const days = Array.isArray(c.days) ? c.days.map(Number) : [];
    if (!days.includes(Number(day))) return false;
    const cs = parseTime(c.start_time ?? c.start);
    const ce = parseTime(c.end_time ?? c.end);
    if (cs == null || ce == null) return false;
    return rangesOverlap(s, e, cs, ce);
  });
}

// Can the user work a gig in { day, start, end }? They must be inside a declared
// availability window AND not in a class. Rules when windows are sparse:
//   - No availability windows declared at all → generally available (classes still block).
//   - Windows declared, but none on this day → NOT available this day.
export function isFreeAt(availability = [], classSchedule = [], { day, start, end } = {}) {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s == null || e == null) return true; // unknown time → don't block
  if (classOverlaps(classSchedule, { day, start, end })) return false;

  const all = availability || [];
  if (all.length === 0) return true; // nothing declared → assume available

  const windows = windowsForDay(all, day);
  if (windows.length === 0) return false; // has windows elsewhere, none today
  return windows.some((w) => {
    const ws = parseTime(w.start);
    const we = parseTime(w.end);
    return ws != null && we != null && s >= ws && e <= we;
  });
}

// Human-readable one-liner of availability windows, e.g. "Mon 3pm–8pm · Sat 9am–5pm".
export function availabilitySummary(availability = []) {
  const all = availability || [];
  if (all.length === 0) return 'No availability set';
  const byDay = {};
  for (const w of all) {
    const d = Number(w.day);
    (byDay[d] = byDay[d] || []).push(`${fmtTime(w.start)}–${fmtTime(w.end)}`);
  }
  return Object.keys(byDay)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => `${DAYS[d]} ${byDay[d].join(', ')}`)
    .join(' · ');
}
