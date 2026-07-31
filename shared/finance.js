// Pure finance helpers for the hustler "money goal" coach (no native imports,
// fully unit-testable). Used by mobile, web, and the AI assistant edge function.
import { isJobBookable, isHiddenForViewer } from './filters.js';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * The one way to render a dollar amount, so the three clients cannot disagree
 * about what a number looks like.
 *
 * A bare `n.toLocaleString()` formats 2640.5 as "2,640.5" — one decimal place,
 * which no currency uses — and 2640.567 as "2,640.567". Money is either whole
 * dollars or exactly two decimals, never one and never three. Thousands
 * separators are always on: mobile had them and web did not, so the same
 * earnings total read "$2,640.5" in the app and "$2640.50" on the site.
 */
export function formatMoney(n) {
  const v = Number(n) || 0;
  const digits = v % 1 === 0 ? 0 : 2;
  // Sign goes OUTSIDE the symbol: "-$12.50", not "$-12.50". Tax Center shows a
  // negative net profit whenever expenses outrun income, so this is reachable.
  const body = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${v < 0 ? '-' : ''}$${body}`;
}

// IRS standard mileage rate for business use, in dollars per mile.
// Used to value an auto-logged gig drive as a deductible expense
// (miles × rate). Update annually when the IRS publishes the new rate
// (0.70 = 2025 rate; confirm the current-year figure each January).
export const IRS_MILEAGE_RATE = 0.70;

// Sensible per-hour starting rates when we have no other signal.
export const CATEGORY_BASE_RATES = {
  Tutoring: 25,
  Delivery: 18,
  Moving: 25,
  'Tech Help': 30,
  Creative: 35,
  'Odd Jobs': 20,
  Errands: 18,
};

// Plan to hit a monthly earning goal given month-to-date progress.
// `now` is injectable for testing; defaults to the current date at runtime.
export function computeGoalPlan({
  monthlyGoal,
  earnedThisMonth = 0,
  avgGigValue = 0,
  gigsThisMonth = 0,
  now = new Date(),
} = {}) {
  const goal = Math.max(0, Number(monthlyGoal) || 0);
  const earned = Math.max(0, Number(earnedThisMonth) || 0);
  const avg = Math.max(0, Number(avgGigValue) || 0);

  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);

  const remaining = Math.max(0, goal - earned);
  const pctComplete = goal > 0 ? Math.min(1, earned / goal) : 0;

  const gigsNeeded = avg > 0 ? Math.ceil(remaining / avg) : null;
  const perDayNeeded = daysLeft > 0 ? remaining / daysLeft : remaining;
  // Never quote a weekly figure larger than what is actually left to earn. With
  // fewer than 7 days to go the raw daily-rate×7 overshoots the whole goal — on
  // the last day of a month it read "$6,685 per week" to close a $955 gap, a
  // number the user can neither owe nor act on.
  const perWeekNeeded = Math.min(remaining, perDayNeeded * 7);

  // Pace projection: extrapolate the current run-rate to month end.
  const projectedTotal = dayOfMonth > 0 ? (earned / dayOfMonth) * daysInMonth : earned;
  const expectedByNow = goal * (dayOfMonth / daysInMonth);

  let status;
  if (goal <= 0) status = 'unset';
  else if (earned >= goal) status = 'reached';
  else if (earned >= expectedByNow) status = 'ahead';
  else if (projectedTotal >= goal * 0.9) status = 'onTrack';
  else status = 'behind';

  return {
    goal,
    earned,
    remaining,
    pctComplete,
    daysInMonth,
    dayOfMonth,
    daysLeft,
    gigsNeeded,
    perDayNeeded: round2(perDayNeeded),
    perWeekNeeded: round2(perWeekNeeded),
    projectedTotal: round2(projectedTotal),
    expectedByNow: round2(expectedByNow),
    gigsThisMonth: Math.max(0, Number(gigsThisMonth) || 0),
    status, // 'unset' | 'behind' | 'onTrack' | 'ahead' | 'reached'
  };
}

// Suggest a fair rate as a low/typical/high band, blending the user's own rate
// (from profiles.skill_rates) with the local market average for the category.
export function suggestRate({ category, skillRate = null, marketAvg = null } = {}) {
  const sr = Math.max(0, Number(skillRate) || 0);
  const ma = Math.max(0, Number(marketAvg) || 0);
  let base;
  let basis;
  if (sr > 0 && ma > 0) {
    base = (sr + ma) / 2;
    basis = 'your rate + market';
  } else if (sr > 0) {
    base = sr;
    basis = 'your rate';
  } else if (ma > 0) {
    base = ma;
    basis = 'market';
  } else {
    base = CATEGORY_BASE_RATES[category] || 20;
    basis = 'category default';
  }
  return {
    low: Math.round(base * 0.85),
    typical: Math.round(base),
    high: Math.round(base * 1.2),
    basis,
  };
}

// Market stats (avg + median pay) for a category from a list of jobs.
export function marketRate(jobs = [], category = null) {
  const pays = (jobs || [])
    .filter((j) => !category || j.category === category)
    .map((j) => Number(j.pay))
    .filter((p) => p > 0)
    .sort((a, b) => a - b);
  if (pays.length === 0) return { avg: null, median: null, count: 0 };
  const avg = pays.reduce((s, p) => s + p, 0) / pays.length;
  const mid = Math.floor(pays.length / 2);
  const median = pays.length % 2 ? pays[mid] : (pays[mid - 1] + pays[mid]) / 2;
  return { avg: round2(avg), median: round2(median), count: pays.length };
}

// Score a gig by how well it fits the user's skills and how much it moves them
// toward their remaining goal. Higher = better.
export function scoreGig(job, { skills = [], remaining = 0 } = {}) {
  if (!job) return 0;
  const hay = `${job.title || ''} ${job.description || ''} ${job.category || ''}`.toLowerCase();
  let score = 0;
  for (const s of skills) {
    const k = String(s).toLowerCase().trim();
    if (k && hay.includes(k)) score += 3;
  }
  const pay = Math.max(0, Number(job.pay) || 0);
  if (remaining > 0) score += Math.min(3, (pay / remaining) * 6);
  else score += Math.min(2, pay / 50);
  if (job.urgent) score += 0.5;
  return round2(score);
}

// Rank gigs best-first for closing the user's goal.
//
// Eligibility is applied HERE rather than left to each caller. "Best gigs to hit
// your goal" is a call to action — every row has to be a gig the reader can
// actually book — and both callers previously filtered on `status === 'open'`
// alone. That let two kinds of dead row through:
//   * a gig whose every slot is already taken (bookable by nobody), because
//     jobs.status never leaves 'open' (its 'booked' value is a dead enum), and
//   * a gig THIS viewer already won, which Browse hides but the goal card still
//     recommended — so the same gig appeared twice on the card and once in Browse.
// isJobBookable/isHiddenForViewer are the same rules Browse applies, so the two
// surfaces can no longer disagree about what is bookable.
//
// `myBookings` is optional: omitted, only the viewer-independent rule applies.
export function rankGigsForGoal(jobs = [], opts = {}) {
  const { myBookings } = opts;
  return [...(jobs || [])]
    .filter((j) => isJobBookable(j) && !isHiddenForViewer(j, myBookings))
    .map((j) => ({ job: j, score: scoreGig(j, opts) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.job);
}
