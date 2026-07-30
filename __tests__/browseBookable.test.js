import { isJobBookable, applyJobFilters, DEFAULT_FILTERS } from '../shared/filters.js';

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
