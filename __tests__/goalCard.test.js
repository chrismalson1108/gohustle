import { computeGoalPlan, rankGigsForGoal, formatMoney } from '../shared/finance.js';

// The "Best gigs to hit your goal" list is a call to action: every row has to be
// a gig the reader can actually book. Both clients used to filter on
// `status === 'open'` alone, which is not the same question — jobs.status never
// leaves 'open' (its 'booked' value is a dead enum), so gigs nobody could book,
// and gigs the viewer had already won, were being recommended.
const gig = (over = {}) => ({
  id: 'j1',
  status: 'open',
  title: 'Meandering analyst',
  pay: 40,
  slots: [{ id: 's1', label: 'Flexible', taken: false }],
  ...over,
});

describe('rankGigsForGoal eligibility', () => {
  test('a bookable open gig is recommended', () => {
    expect(rankGigsForGoal([gig()]).map((j) => j.id)).toEqual(['j1']);
  });

  test('a gig whose every slot is taken is NOT recommended', () => {
    const dead = gig({ slots: [{ id: 's1', taken: true }] });
    expect(rankGigsForGoal([dead])).toEqual([]);
  });

  test('a gig this viewer already won is NOT recommended — the reported duplicate', () => {
    // The exact live symptom: one job row, still bookable by others, but already
    // won by the reader. Browse hid it; the goal card recommended it anyway, so
    // the same title appeared twice on the card and once in Browse.
    const mine = [{ jobId: 'j1', status: 'confirmed' }];
    expect(rankGigsForGoal([gig()], { myBookings: mine })).toEqual([]);
  });

  test('pending/declined bookings do NOT hide a gig — re-applying is legitimate', () => {
    for (const status of ['pending', 'declined']) {
      const bookings = [{ jobId: 'j1', status }];
      expect(rankGigsForGoal([gig()], { myBookings: bookings }).map((j) => j.id)).toEqual(['j1']);
    }
  });

  test('a cancelled gig is NOT recommended', () => {
    expect(rankGigsForGoal([gig({ status: 'cancelled' })])).toEqual([]);
  });

  test('eligibility matches Browse: rankGigsForGoal never returns a gig Browse would hide', () => {
    // Structural invariant rather than a point fix — any future divergence between
    // the two surfaces' notions of "bookable" fails here.
    const mine = [{ jobId: 'won', status: 'verified' }];
    const jobs = [
      gig({ id: 'ok' }),
      gig({ id: 'won' }),
      gig({ id: 'full', slots: [{ id: 's', taken: true }] }),
      gig({ id: 'gone', status: 'cancelled' }),
    ];
    expect(rankGigsForGoal(jobs, { myBookings: mine }).map((j) => j.id)).toEqual(['ok']);
  });
});

describe('computeGoalPlan pace never overstates what is left', () => {
  test('perWeekNeeded is capped at the remaining amount', () => {
    // Last day of a 31-day month: $955 to go, 1 day left. The raw daily-rate×7
    // read "$6,685 per week" — seven times the entire remaining goal.
    const plan = computeGoalPlan({
      monthlyGoal: 1000,
      earnedThisMonth: 45,
      avgGigValue: 22,
      now: new Date(2026, 6, 30), // 30 Jul 2026 -> daysLeft = 1
    });
    expect(plan.daysLeft).toBe(1);
    expect(plan.remaining).toBe(955);
    expect(plan.perWeekNeeded).toBe(955);
    expect(plan.perWeekNeeded).toBeLessThanOrEqual(plan.remaining);
  });

  test('with a full week or more left the weekly rate is unchanged', () => {
    const plan = computeGoalPlan({
      monthlyGoal: 1000,
      earnedThisMonth: 0,
      now: new Date(2026, 6, 1), // 30 days left
    });
    expect(plan.perWeekNeeded).toBeCloseTo((1000 / 30) * 7, 2);
  });

  test('a weekly figure larger than the remaining goal is never produced, any day of the month', () => {
    for (let day = 1; day <= 31; day++) {
      const plan = computeGoalPlan({
        monthlyGoal: 1000,
        earnedThisMonth: 100,
        now: new Date(2026, 6, day),
      });
      expect(plan.perWeekNeeded).toBeLessThanOrEqual(plan.remaining + 0.01);
    }
  });
});

describe('formatMoney', () => {
  test('renders exactly two decimals, never one — the "$2,640.5" bug', () => {
    expect(formatMoney(2640.5)).toBe('$2,640.50');
  });

  test('whole dollars stay whole', () => {
    expect(formatMoney(2640)).toBe('$2,640');
  });

  test('never renders three decimals', () => {
    expect(formatMoney(880.167)).toBe('$880.17');
  });

  test('thousands are separated', () => {
    expect(formatMoney(1234567.89)).toBe('$1,234,567.89');
  });

  test('null/undefined/NaN degrade to $0 rather than "$NaN"', () => {
    for (const v of [null, undefined, NaN, 'abc']) expect(formatMoney(v)).toBe('$0');
  });

  test('negatives keep their sign and precision', () => {
    expect(formatMoney(-12.5)).toBe('-$12.50');
  });
});
