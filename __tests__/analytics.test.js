import { computeEarnerInsights } from '../src/lib/insights';

// Helper to build a verified booking quickly. `date` is the completedAt timestamp.
function vb({ location, pay, counterOffer, tipAmount, date, status = 'verified' }) {
  return {
    status,
    counterOffer: counterOffer ?? null,
    tipAmount: tipAmount ?? 0,
    completedAt: date ?? null,
    startsAt: null,
    createdAt: null,
    job: { id: 'j', title: 'Gig', pay, payType: 'flat', location: location ?? null },
  };
}

describe('analytics.computeEarnerInsights', () => {
  test('returns null when there are no verified bookings', () => {
    expect(computeEarnerInsights([])).toBeNull();
    expect(computeEarnerInsights(null)).toBeNull();
    expect(
      computeEarnerInsights([
        vb({ location: 'Austin, TX', pay: 50, date: '2026-06-06T10:00:00Z', status: 'pending' }),
        vb({ location: 'Austin, TX', pay: 50, date: '2026-06-06T10:00:00Z', status: 'confirmed' }),
      ]),
    ).toBeNull();
  });

  test('computes top area, busiest day, and most profitable day', () => {
    // 2026-06-06 is a Saturday; 2026-06-05 is a Friday; 2026-06-08 is a Monday.
    const bookings = [
      // Austin: 3 gigs total — two Saturdays, one Friday
      vb({ location: 'Austin, TX', pay: 50, date: '2026-06-06T10:00:00Z' }), // Sat $50
      vb({ location: 'Austin, TX', pay: 60, date: '2026-06-06T14:00:00Z' }), // Sat $60
      vb({ location: 'Austin, TX', pay: 100, counterOffer: 120, tipAmount: 80, date: '2026-06-05T09:00:00Z' }), // Fri $200 (counter 120 + tip 80)
      // Dallas: 1 gig on a Monday
      vb({ location: 'Dallas, TX', pay: 70, date: '2026-06-08T09:00:00Z' }), // Mon $70
    ];

    const ins = computeEarnerInsights(bookings);
    expect(ins).not.toBeNull();
    expect(ins.jobCount).toBe(4);

    // Top area = Austin (3 of 4 gigs)
    expect(ins.topArea).toEqual({ label: 'Austin, TX', count: 3 });

    // Busiest day = Saturday (2 gigs vs 1 each for Friday/Monday)
    expect(ins.busiestDay).toEqual({ label: 'Saturday', count: 2 });

    // Most profitable day = Friday ($200) beats Saturday ($110) and Monday ($70)
    expect(ins.mostProfitableDay).toEqual({ label: 'Friday', total: 200 });
  });

  test('ignores empty/missing locations and undatable bookings defensively', () => {
    const bookings = [
      vb({ location: '   ', pay: 40, date: '2026-06-06T10:00:00Z' }), // blank location skipped from areas
      vb({ location: null, pay: 40, date: '2026-06-06T10:00:00Z' }), // null location skipped from areas
      vb({ location: 'Houston, TX', pay: 90, date: null }), // no date → skipped from day stats, still counts as a gig + area
    ];
    const ins = computeEarnerInsights(bookings);
    expect(ins.jobCount).toBe(3);
    // Only Houston had a usable location
    expect(ins.topArea).toEqual({ label: 'Houston, TX', count: 1 });
    // Two Saturday gigs had dates (the blank/null-location ones)
    expect(ins.busiestDay).toEqual({ label: 'Saturday', count: 2 });
    expect(ins.mostProfitableDay).toEqual({ label: 'Saturday', total: 80 });
  });

  test('falls back to job.pay when no counter-offer, and adds tips', () => {
    const ins = computeEarnerInsights([
      vb({ location: 'Reno, NV', pay: 45, tipAmount: 5, date: '2026-06-05T10:00:00Z' }), // Fri $50
    ]);
    expect(ins.mostProfitableDay).toEqual({ label: 'Friday', total: 50 });
  });
});
