import { isJobBookable, isHiddenForViewer, applyJobFilters, DEFAULT_FILTERS } from '../shared/filters.js';

// Browse must show only gigs someone can actually book. This is slot-aware on
// purpose: `jobs.status` never leaves 'open' (its 'booked' value is a dead enum,
// KNOWN_RISKS §5.1), so status alone left finished gigs sitting in the feed.
const job = (over = {}) => ({
  id: 'j1',
  status: 'open',
  title: 'Meandering analyst',
  description: 'analyze how well I have been meandering',
  category: 'Tutoring',
  pay: 40,
  payType: 'flat',
  location: 'Plano, TX',
  slots: [{ id: 's1', label: 'Flexible', taken: false }],
  ...over,
});

describe('isJobBookable', () => {
  test('an open gig with a free slot is bookable', () => {
    expect(isJobBookable(job())).toBe(true);
  });

  test('a gig whose only slot is taken is NOT bookable — the reported bug', () => {
    expect(isJobBookable(job({ slots: [{ id: 's1', label: 'Flexible', taken: true }] }))).toBe(false);
  });

  test('MULTI-SLOT: one slot taken, another free -> still bookable', () => {
    // Someone booking Tuesday must not hide the gig from someone who wants Thursday.
    expect(isJobBookable(job({
      slots: [
        { id: 's1', label: 'Tue', taken: true },
        { id: 's2', label: 'Thu', taken: false },
      ],
    }))).toBe(true);
  });

  test('MULTI-SLOT: every slot taken -> not bookable', () => {
    expect(isJobBookable(job({
      slots: [
        { id: 's1', label: 'Tue', taken: true },
        { id: 's2', label: 'Thu', taken: true },
      ],
    }))).toBe(false);
  });

  test('a cancelled (soft-deleted) gig is never bookable, free slot or not', () => {
    expect(isJobBookable(job({ status: 'cancelled' }))).toBe(false);
    expect(isJobBookable(job({ status: 'completed' }))).toBe(false);
  });

  test('fails OPEN on missing/empty slots rather than hiding a listing', () => {
    // PostJob always attaches a Flexible slot, so this is anomalous data. Showing an
    // unbookable gig is a smaller harm than silently hiding real ones.
    expect(isJobBookable(job({ slots: [] }))).toBe(true);
    expect(isJobBookable(job({ slots: undefined }))).toBe(true);
  });

  test('null/undefined job is not bookable', () => {
    expect(isJobBookable(null)).toBe(false);
    expect(isJobBookable(undefined)).toBe(false);
  });
});

describe('applyJobFilters drops unbookable gigs from Browse', () => {
  const opts = { selectedCat: 'all', search: '', filters: DEFAULT_FILTERS };

  test('the finished gig disappears while the open one stays', () => {
    const open = job({ id: 'open' });
    const done = job({ id: 'done', slots: [{ id: 's1', label: 'Flexible', taken: true }] });
    const out = applyJobFilters([open, done], opts).map(j => j.id);
    expect(out).toContain('open');
    expect(out).not.toContain('done');
  });

  test('a partially-booked multi-slot gig survives the feed filter', () => {
    const partial = job({
      id: 'partial',
      slots: [{ id: 'a', taken: true, label: 'Tue' }, { id: 'b', taken: false, label: 'Thu' }],
    });
    expect(applyJobFilters([partial], opts).map(j => j.id)).toEqual(['partial']);
  });
});

// isJobBookable asks "can ANYONE book this?"; isHiddenForViewer asks "should THIS
// person still see it?". The reported gig had 9 slots with only 2 taken — genuinely
// still open to others — so only the viewer rule removes it from the earner's feed.
describe('isHiddenForViewer', () => {
  const j = { id: 'j1' };
  test('hidden once the viewer holds it', () => {
    for (const status of ['confirmed', 'completed', 'verified']) {
      expect(isHiddenForViewer(j, [{ jobId: 'j1', status }])).toBe(true);
    }
  });

  test('a pending application still shows — they have not got it yet', () => {
    expect(isHiddenForViewer(j, [{ jobId: 'j1', status: 'pending' }])).toBe(false);
  });

  test('declined still shows — the slot is free again and re-applying is legitimate', () => {
    expect(isHiddenForViewer(j, [{ jobId: 'j1', status: 'declined' }])).toBe(false);
  });

  test("another user's booking on the same gig is irrelevant", () => {
    expect(isHiddenForViewer(j, [{ jobId: 'other', status: 'verified' }])).toBe(false);
  });

  test('no bookings / missing args are safe', () => {
    expect(isHiddenForViewer(j, [])).toBe(false);
    expect(isHiddenForViewer(j, null)).toBe(false);
    expect(isHiddenForViewer(null, [{ jobId: 'j1', status: 'verified' }])).toBe(false);
  });
});

describe('the exact reported case', () => {
  test('9 slots, 2 taken, viewer already completed it -> bookable but hidden from them', () => {
    const slots = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, taken: i < 2 }));
    const gig = { id: 'meander', status: 'open', title: 'Meandering analyst', description: '',
      category: 'Tutoring', pay: 40, payType: 'flat', location: 'Plano, TX', slots };
    expect(isJobBookable(gig)).toBe(true);            // still open to other earners
    const mine = [{ jobId: 'meander', status: 'verified' }];
    expect(isHiddenForViewer(gig, mine)).toBe(true);  // but not to the one who did it
    const out = applyJobFilters([gig], { filters: DEFAULT_FILTERS, myBookings: mine });
    expect(out).toHaveLength(0);
  });
});
