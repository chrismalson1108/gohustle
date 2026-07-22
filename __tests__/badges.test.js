import { BADGE_DEFS, BADGE_GROUPS } from '../shared/constants.js';
import { badgeStatus, evaluateBadges, newlyEarned, BADGE_KEYS, emptyBadgeMap } from '../shared/badges.js';

const done = (over = {}) => ({ status: 'verified', ...over });

describe('badge catalog integrity', () => {
  it('every badge has a rule that returns a well-formed status', () => {
    BADGE_KEYS.forEach(key => {
      const s = badgeStatus(key, {});
      expect(typeof s.earned).toBe('boolean');
      expect(typeof s.current).toBe('number');
    });
  });

  it('every badge has a label, description, icon and a known group', () => {
    const groups = new Set(BADGE_GROUPS.map(g => g.id));
    // Report the offending keys rather than failing on an anonymous assertion.
    const broken = Object.entries(BADGE_DEFS)
      .filter(([, d]) => !d.label || !d.desc || !d.ion || !groups.has(d.group))
      .map(([k]) => k);
    expect(broken).toEqual([]);
  });

  it('awards nothing to a brand-new user', () => {
    expect(evaluateBadges({})).toEqual([]);
  });

  // Regression: UserContext seeded state from a hand-written list of 5 keys, so
  // every badge added later was dropped when loading from the DB — they
  // re-unlocked and re-toasted on every session.
  it('emptyBadgeMap covers the WHOLE catalogue, so no unlocked badge is dropped on load', () => {
    const map = emptyBadgeMap();
    expect(Object.keys(map).sort()).toEqual([...BADGE_KEYS].sort());
    BADGE_KEYS.forEach(k => expect(map[k]).toEqual({ unlocked: false }));
  });

  it('a persisted unlock for any badge survives a reload', () => {
    BADGE_KEYS.forEach(key => {
      const restored = { ...emptyBadgeMap(), [key]: { unlocked: true } };
      // newlyEarned must not re-report a badge already recorded as unlocked.
      const ctx = { earningsTotal: 999999, streakDays: 99, verified: true };
      expect(newlyEarned(ctx, restored)).not.toContain(key);
    });
  });

  it('never throws on malformed rows', () => {
    const junk = {
      bookings: [null, {}, { status: 'verified', job: null }, { startsAt: 'nonsense' }],
      posterBookings: [null, {}],
      reviews: [null, {}, { rating: 'x' }],
      postedJobs: [null],
    };
    expect(() => evaluateBadges(junk)).not.toThrow();
  });
});

describe('work + earnings milestones', () => {
  it('unlocks First Hustle on the first finished gig, not on a pending one', () => {
    expect(evaluateBadges({ bookings: [{ status: 'pending' }] })).not.toContain('firstHustle');
    expect(evaluateBadges({ bookings: [done()] })).toContain('firstHustle');
  });

  it('counts completed as well as verified', () => {
    expect(evaluateBadges({ bookings: [{ status: 'completed' }] })).toContain('firstHustle');
  });

  it('tiers gig milestones', () => {
    const mk = n => ({ bookings: Array.from({ length: n }, () => done()) });
    expect(evaluateBadges(mk(9))).not.toContain('tenGigs');
    expect(evaluateBadges(mk(10))).toContain('tenGigs');
    expect(evaluateBadges(mk(25))).toEqual(expect.arrayContaining(['tenGigs', 'quarterTon']));
    expect(evaluateBadges(mk(100))).toContain('centurion');
  });

  it('tiers earnings and reports partial progress on locked tiers', () => {
    expect(evaluateBadges({ earningsTotal: 99 })).not.toContain('firstHundred');
    expect(evaluateBadges({ earningsTotal: 100 })).toContain('firstHundred');
    expect(evaluateBadges({ earningsTotal: 2604 })).toEqual(
      expect.arrayContaining(['firstHundred', 'bigEarner']),
    );
    expect(evaluateBadges({ earningsTotal: 2604 })).not.toContain('highRoller');
    expect(badgeStatus('highRoller', { earningsTotal: 2604 })).toMatchObject({
      earned: false, current: 2604, target: 5000,
    });
  });

  it('awards Well Tipped only on a real tip', () => {
    expect(evaluateBadges({ bookings: [done({ tipAmount: 0 })] })).not.toContain('wellTipped');
    expect(evaluateBadges({ bookings: [done({ tipAmount: 5 })] })).toContain('wellTipped');
  });
});

describe('reputation', () => {
  it('needs a 5-star review, not just any review', () => {
    expect(evaluateBadges({ reviews: [{ rating: 4 }] })).not.toContain('fiveStar');
    expect(evaluateBadges({ reviews: [{ rating: 5 }] })).toContain('fiveStar');
  });

  it('Top Rated requires ten 5-star reviews', () => {
    const five = n => ({ reviews: Array.from({ length: n }, () => ({ rating: 5 })) });
    expect(evaluateBadges(five(9))).not.toContain('topRated');
    expect(evaluateBadges(five(10))).toContain('topRated');
  });

  it('Crowd Pleaser counts all reviews regardless of score', () => {
    const mixed = Array.from({ length: 25 }, (_, i) => ({ rating: i % 2 ? 3 : 5 }));
    expect(evaluateBadges({ reviews: mixed })).toContain('crowdPleaser');
  });

  it('streak tiers', () => {
    expect(evaluateBadges({ streakDays: 4 })).not.toContain('onFire');
    expect(evaluateBadges({ streakDays: 5 })).toContain('onFire');
    expect(evaluateBadges({ streakDays: 10 })).toContain('unstoppable');
  });
});

describe('style badges', () => {
  it('Speed Demon needs an apply within 30 min of posting', () => {
    const posted = '2026-07-01T10:00:00.000Z';
    const fast = { bookings: [{ status: 'pending', createdAt: '2026-07-01T10:20:00.000Z', job: { createdAt: posted } }] };
    const slow = { bookings: [{ status: 'pending', createdAt: '2026-07-01T14:00:00.000Z', job: { createdAt: posted } }] };
    expect(evaluateBadges(fast)).toContain('speedDemon');
    expect(evaluateBadges(slow)).not.toContain('speedDemon');
  });

  it('Speed Demon ignores bookings missing either timestamp', () => {
    expect(evaluateBadges({ bookings: [{ createdAt: '2026-07-01T10:10:00Z', job: {} }] })).not.toContain('speedDemon');
    expect(evaluateBadges({ bookings: [{ job: { createdAt: '2026-07-01T10:00:00Z' } }] })).not.toContain('speedDemon');
  });

  it('Early Bird / Night Owl key off the slot start hour', () => {
    // Construct local-time dates so the assertion is timezone-independent.
    const at = (h) => { const d = new Date(2026, 6, 1, h, 0, 0); return d.toISOString(); };
    expect(evaluateBadges({ bookings: [done({ startsAt: at(6) })] })).toContain('earlyBird');
    expect(evaluateBadges({ bookings: [done({ startsAt: at(21) })] })).toContain('nightOwl');
    expect(evaluateBadges({ bookings: [done({ startsAt: at(13) })] })).not.toEqual(
      expect.arrayContaining(['earlyBird', 'nightOwl']),
    );
  });

  it('Weekend Warrior needs 5 weekend gigs', () => {
    // 2026-07-04 is a Saturday, 2026-07-05 a Sunday.
    const sat = new Date(2026, 6, 4, 10).toISOString();
    const wed = new Date(2026, 6, 1, 10).toISOString();
    const mk = (iso, n) => Array.from({ length: n }, () => done({ startsAt: iso }));
    expect(evaluateBadges({ bookings: mk(sat, 4) })).not.toContain('weekendWared');
    expect(evaluateBadges({ bookings: mk(sat, 5) })).toContain('weekendWared');
    expect(evaluateBadges({ bookings: mk(wed, 5) })).not.toContain('weekendWared');
  });

  it('Jack of All needs 5 distinct categories, not 5 gigs', () => {
    const same = Array.from({ length: 5 }, () => done({ job: { category: 'Moving' } }));
    expect(evaluateBadges({ bookings: same })).not.toContain('jackOfAll');
    const varied = ['Moving', 'Tutoring', 'Delivery', 'Creative', 'Errands']
      .map(category => done({ job: { category } }));
    expect(evaluateBadges({ bookings: varied })).toContain('jackOfAll');
  });

  it('The Regular needs 3 gigs for one client', () => {
    const spread = ['a', 'b', 'c'].map(posterId => done({ job: { posterId } }));
    expect(evaluateBadges({ bookings: spread })).not.toContain('regular');
    const loyal = Array.from({ length: 3 }, () => done({ job: { posterId: 'a' } }));
    expect(evaluateBadges({ bookings: loyal })).toContain('regular');
  });

  it('Negotiator needs an accepted counter-offer', () => {
    expect(evaluateBadges({ bookings: [{ status: 'pending', counterOffer: 50 }] })).not.toContain('negotiator');
    expect(evaluateBadges({ bookings: [{ status: 'confirmed', counterOffer: 50 }] })).toContain('negotiator');
  });
});

describe('hiring badges', () => {
  it('Now Hiring on first posted gig', () => {
    expect(evaluateBadges({ postedJobs: [{ id: 'j1' }] })).toContain('firstPost');
  });

  it('Good Boss counts only verified hires', () => {
    const mk = (status, n) => Array.from({ length: n }, () => ({ status }));
    expect(evaluateBadges({ posterBookings: mk('completed', 5) })).not.toContain('goodBoss');
    expect(evaluateBadges({ posterBookings: mk('verified', 5) })).toContain('goodBoss');
  });

  it('Big Spender sums every verified hire, preferring the counter-offer', () => {
    const hires = [
      { status: 'verified', job: { pay: 400 } },
      { status: 'verified', job: { pay: 400 } },
      { status: 'verified', counterOffer: 300, job: { pay: 100 } },
    ];
    // 400 + 400 + 300 = 1100 — the earlier precedence bug summed to 800 here.
    expect(badgeStatus('bigSpender', { posterBookings: hires })).toMatchObject({ earned: true });
  });

  it('Generous needs tips on 3 jobs', () => {
    const tipped = n => ({ posterBookings: Array.from({ length: n }, () => ({ tipAmount: 5 })) });
    expect(evaluateBadges(tipped(2))).not.toContain('tipper');
    expect(evaluateBadges(tipped(3))).toContain('tipper');
  });
});

describe('trust badges', () => {
  it('Verified follows the profile flag', () => {
    expect(evaluateBadges({ verified: true })).toContain('idVerified');
    expect(evaluateBadges({ verified: false })).not.toContain('idVerified');
  });

  it('All Star needs photo + bio + 3 skills', () => {
    const full = { avatarUrl: 'u', bio: 'hi', skills: ['a', 'b', 'c'] };
    expect(evaluateBadges(full)).toContain('allStar');
    expect(evaluateBadges({ ...full, avatarUrl: null })).not.toContain('allStar');
    expect(evaluateBadges({ ...full, bio: '   ' })).not.toContain('allStar');
    expect(evaluateBadges({ ...full, skills: ['a'] })).not.toContain('allStar');
  });

  it('Connector needs a referral', () => {
    expect(evaluateBadges({ referrals: 0 })).not.toContain('connector');
    expect(evaluateBadges({ referrals: 1 })).toContain('connector');
  });
});

describe('newlyEarned', () => {
  it('returns only badges not already unlocked', () => {
    const ctx = { earningsTotal: 1500, bookings: [{ status: 'verified' }] };
    const all = evaluateBadges(ctx);
    expect(all).toEqual(expect.arrayContaining(['firstHustle', 'firstHundred', 'bigEarner']));

    const existing = { firstHustle: { unlocked: true }, firstHundred: { unlocked: true } };
    expect(newlyEarned(ctx, existing)).toEqual(['bigEarner']);
  });

  it('is empty once everything earned is recorded', () => {
    const ctx = { earningsTotal: 150 };
    const existing = Object.fromEntries(evaluateBadges(ctx).map(k => [k, { unlocked: true }]));
    expect(newlyEarned(ctx, existing)).toEqual([]);
  });

  it("the screenshot's profile (3 gigs, $2,604, two 5-star reviews) earns real badges", () => {
    const ctx = {
      bookings: Array.from({ length: 3 }, () => ({ status: 'verified' })),
      earningsTotal: 2604.5,
      reviews: [{ rating: 5 }, { rating: 5 }],
    };
    // Previously this user saw five padlocks and nothing else.
    expect(evaluateBadges(ctx).sort()).toEqual(
      ['bigEarner', 'firstHundred', 'firstHustle', 'fiveStar'].sort(),
    );
  });
});
