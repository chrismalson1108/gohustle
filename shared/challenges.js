// Challenge periods.
//
// Challenges are typed 'daily' or 'weekly' and their copy says so ("Apply to 3
// gigs today", "Earn $100 This Week") — but nothing ever reset them, so once a
// challenge hit its target it sat on the Progress pane reading "Done ·
// Complete!" forever. These helpers give a challenge a PERIOD, so progress from
// a previous day/week reads as zero and the challenge is live again.
//
// Weeks start Monday, matching the weekly-goal maths in WeeklyGoalsCard and
// EarnScreen, so "this week" means the same thing everywhere in the app.

// Stable key for the period a date falls in: 'YYYY-MM-DD' for daily,
// 'YYYY-Www' for weekly. Same key => same period => progress still counts.
export function periodKey(type, date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (type === 'weekly') {
    const m = new Date(d);
    m.setHours(0, 0, 0, 0);
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); // back to Monday
    return `${m.getFullYear()}-W${String(m.getMonth() + 1).padStart(2, '0')}${String(m.getDate()).padStart(2, '0')}`;
  }
  // 'daily' and anything unrecognised: a calendar day. Falling back to the
  // SHORTER period is deliberate — a challenge that resets too often is a
  // nuisance, one that never resets is the bug this exists to fix.
  const y = d.getFullYear();
  return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Did `updatedAt` happen in the same period as `now`? Missing/unparseable
// timestamps count as stale so old rows (written before periods existed, and
// therefore with no reliable timestamp) start fresh rather than staying stuck.
export function isSamePeriod(type, updatedAt, now = new Date()) {
  if (!updatedAt) return false;
  const then = periodKey(type, new Date(updatedAt));
  return !!then && then === periodKey(type, now);
}

// Progress to SHOW for a challenge whose stored row was last touched at
// `updatedAt`: the stored value inside its period, zero outside it.
export function livingProgress(challenge, updatedAt, now = new Date()) {
  if (!challenge) return 0;
  const stored = Number(challenge.progress) || 0;
  return isSamePeriod(challenge.type, updatedAt, now) ? stored : 0;
}

export function isComplete(challenge) {
  if (!challenge) return false;
  return (Number(challenge.progress) || 0) >= (Number(challenge.target) || 1);
}

// When the challenge comes back. Shown next to finished ones so "Done" reads as
// "done for now" rather than "done forever" — the thing that made three
// permanently-complete cards look like broken badges.
export function resetLabel(type) {
  return type === 'weekly' ? 'Resets Monday' : 'Resets tomorrow';
}
