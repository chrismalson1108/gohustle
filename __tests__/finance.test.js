import {
  computeGoalPlan,
  suggestRate,
  marketRate,
  scoreGig,
  rankGigsForGoal,
} from '../src/lib/finance';

describe('finance.computeGoalPlan', () => {
  // June 2026 has 30 days; pin "now" to June 15 (half the month gone).
  const now = new Date(2026, 5, 15, 12, 0, 0);

  test('behind pace when earnings trail expectation', () => {
    const p = computeGoalPlan({ monthlyGoal: 1000, earnedThisMonth: 200, avgGigValue: 50, now });
    expect(p.remaining).toBe(800);
    expect(p.gigsNeeded).toBe(16); // ceil(800 / 50)
    expect(p.daysLeft).toBe(15);
    expect(p.expectedByNow).toBe(500); // 1000 * 15/30
    expect(p.status).toBe('behind');
    expect(p.pctComplete).toBeCloseTo(0.2);
  });

  test('ahead when earnings beat expectation', () => {
    const p = computeGoalPlan({ monthlyGoal: 1000, earnedThisMonth: 700, avgGigValue: 100, now });
    expect(p.status).toBe('ahead');
    expect(p.gigsNeeded).toBe(3); // ceil(300 / 100)
  });

  test('reached caps remaining at 0', () => {
    const p = computeGoalPlan({ monthlyGoal: 500, earnedThisMonth: 600, avgGigValue: 50, now });
    expect(p.remaining).toBe(0);
    expect(p.gigsNeeded).toBe(0);
    expect(p.status).toBe('reached');
  });

  test('unset goal is handled', () => {
    const p = computeGoalPlan({ monthlyGoal: 0, earnedThisMonth: 0, now });
    expect(p.status).toBe('unset');
    expect(p.gigsNeeded).toBeNull(); // no avg gig value
  });
});

describe('finance.suggestRate', () => {
  test('blends the user rate and market average', () => {
    const r = suggestRate({ category: 'Tutoring', skillRate: 40, marketAvg: 20 });
    expect(r.typical).toBe(30);
    expect(r.low).toBe(26); // round(30 * 0.85)
    expect(r.high).toBe(36); // round(30 * 1.2)
    expect(r.basis).toBe('your rate + market');
  });

  test('falls back to category default with no signal', () => {
    const r = suggestRate({ category: 'Tech Help' });
    expect(r.typical).toBe(30);
    expect(r.basis).toBe('category default');
  });

  test('unknown category uses the generic floor', () => {
    expect(suggestRate({ category: 'Nonsense' }).typical).toBe(20);
  });
});

describe('finance.marketRate', () => {
  const jobs = [
    { category: 'Moving', pay: 40 },
    { category: 'Moving', pay: 60 },
    { category: 'Moving', pay: 50 },
    { category: 'Tutoring', pay: 25 },
  ];
  test('computes avg + median for a category', () => {
    const m = marketRate(jobs, 'Moving');
    expect(m.count).toBe(3);
    expect(m.avg).toBe(50);
    expect(m.median).toBe(50);
  });
  test('returns nulls when no gigs match', () => {
    expect(marketRate(jobs, 'Delivery')).toEqual({ avg: null, median: null, count: 0 });
  });
});

describe('finance.scoreGig / rankGigsForGoal', () => {
  const jobs = [
    { title: 'Photography for event', description: 'shoot photos', category: 'Creative', pay: 200 },
    { title: 'Move boxes', description: 'lifting', category: 'Moving', pay: 40 },
  ];
  test('skill match and pay both raise the score', () => {
    const withSkill = scoreGig(jobs[0], { skills: ['photography'], remaining: 400 });
    const without = scoreGig(jobs[1], { skills: ['photography'], remaining: 400 });
    expect(withSkill).toBeGreaterThan(without);
  });
  test('ranks the skill-matched, higher-value gig first', () => {
    const ranked = rankGigsForGoal(jobs, { skills: ['photography'], remaining: 400 });
    expect(ranked[0].title).toBe('Photography for event');
  });
});
