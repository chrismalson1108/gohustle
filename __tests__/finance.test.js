import {
  computeGoalPlan,
  suggestRate,
  marketRate,
  scoreGig,
  rankGigsForGoal,
} from '../src/lib/finance';
import { matchesForYou } from '../src/lib/filters';

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

  test('falls back to the category default with no signal', () => {
    const r = suggestRate({ category: 'Tech Help' });
    expect(r.typical).toBe(30);
    expect(r.basis).toBe('category default');
  });

  test('the rate comes from the catalog, not a seven-key copy of it', () => {
    // The old table knew seven categories and quoted $20 for the other 190+.
    expect(suggestRate({ category: 'Plumbing' }).typical).toBe(55);
    expect(suggestRate({ category: 'Snow Removal' }).typical).toBe(28);
    expect(suggestRate({ category: 'lawncare' }).typical).toBe(25); // alias → Lawn Care
  });

  test('a category we do not know quotes a neutral rate and SAYS so', () => {
    // Deliberate change: the old code returned $20 for every user-created category
    // while labelling it "category default", so a brand-new category was presented
    // as having a researched rate of its own. The number is the same; the claim is not.
    const r = suggestRate({ category: 'Drone Piloting' });
    expect(r.typical).toBe(20);
    expect(r.basis).toBe('typical starting rate');
    expect(r.basis).not.toBe('category default');
  });

  test('a missing category is handled like an unknown one', () => {
    expect(suggestRate({}).typical).toBe(20);
    expect(suggestRate().typical).toBe(20);
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
  test('no category means the whole market', () => {
    expect(marketRate(jobs).count).toBe(4);
  });
  test('the market is not split by how each poster spelled the category', () => {
    // Byte-exact label comparison quietly excluded every differently-spelled gig, so
    // the "market average" a user was quoted came from a subset of the market.
    const mixed = [
      { category: 'Lawn Care', pay: 40 },
      { category: 'lawn care', pay: 60 },
      { category: 'LAWNCARE', pay: 50 },
      { category: 'Moving', pay: 500 },
      { categorySlug: 'lawn-care', category: 'whatever', pay: 50 },
    ];
    const m = marketRate(mixed, 'Mowing'); // alias → lawn-care
    expect(m.count).toBe(4);
    expect(m.avg).toBe(50);
  });
});

describe('finance.scoreGig / rankGigsForGoal', () => {
  // `status` is required for a gig to be recommendable: rankGigsForGoal now applies
  // the same bookability rules as Browse, and those fail closed. Real rows always
  // carry it (jobs.status is `not null default 'open'`), so these fixtures were
  // simply under-specified — the assertions below are still about ranking ORDER.
  const jobs = [
    { title: 'Photography for event', description: 'shoot photos', category: 'Creative', pay: 200, status: 'open' },
    { title: 'Move boxes', description: 'lifting', category: 'Moving', pay: 40, status: 'open' },
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

  // scoreGig used to carry its own substring scan of the job text — a third rule with
  // different semantics from matchesForYou and skillFitScore, so the goal card could
  // recommend a gig For You would not show.
  test('skill fit uses the same rule as For You and the hiring Fit sort', () => {
    const gig = { title: 'Weekly visit', description: 'two dogs', category: 'Dog Walking', pay: 40, status: 'open' };
    expect(matchesForYou(gig, ['Dog Walker'])).toBe(true); // alias → dog-walking
    expect(scoreGig(gig, { skills: ['Dog Walker'] })).toBeGreaterThan(scoreGig(gig, { skills: [] }));
  });

  test('a category that is only a substring of a skill no longer inflates the score', () => {
    const gig = { title: 'Fix the office printer', description: 'network is down', category: 'IT', pay: 40, status: 'open' };
    expect(scoreGig(gig, { skills: ['Fitness'] })).toBe(scoreGig(gig, { skills: [] }));
  });
});
