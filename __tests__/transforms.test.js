import { fallbackJobFromBooking, transformBooking } from '../shared/transforms.js';

describe('transformBooking', () => {
  it('maps the fields the badge rules depend on', () => {
    const b = transformBooking({
      id: 'b1',
      job_id: 'j1',
      created_at: '2026-07-01T10:00:00Z',
      status: 'verified',
      tip_amount: '5.00',
      counter_offer: '40',
      job: { id: 'j1', title: 'Move a couch', pay: '100', pay_type: 'flat', location: 'Plano, TX', category: 'Moving', poster_id: 'p1', created_at: '2026-06-30T09:00:00Z' },
    });
    expect(b.createdAt).toBe('2026-07-01T10:00:00Z');
    expect(b.job.category).toBe('Moving');
    expect(b.job.posterId).toBe('p1');
    expect(b.job.createdAt).toBe('2026-06-30T09:00:00Z');
    expect(b.tipAmount).toBe(5);
    expect(b.counterOffer).toBe(40);
  });

  it('tolerates a booking with no joined job', () => {
    const b = transformBooking({ id: 'b1', job_id: 'j1', status: 'pending' });
    expect(b.job).toBeNull();
    expect(b.createdAt).toBeNull();
  });
});

describe('fallbackJobFromBooking', () => {
  // Regression: EarnScreen derived its list from the browse feed only, so a
  // booking whose gig was soft-cancelled (or aged past the 200-row cap)
  // vanished — the earner could not mark done, cancel, or claim payment.
  it('produces every field JobCard dereferences, including poster', () => {
    const job = fallbackJobFromBooking({
      jobId: 'j1',
      job: { title: 'Move a couch', pay: 100, payType: 'flat', location: 'Plano, TX', category: 'Moving', posterId: 'p1', createdAt: '2026-06-30T09:00:00Z' },
    });
    // JobCard reads job.poster.* unguarded — a bare embed would crash it.
    expect(job.poster).toEqual(expect.objectContaining({
      name: expect.any(String), avatarInitial: expect.any(String), rating: expect.any(Number), reviewCount: expect.any(Number),
    }));
    expect(Array.isArray(job.tags)).toBe(true);
    expect(Array.isArray(job.photos)).toBe(true);
    expect(Array.isArray(job.slots)).toBe(true);
    expect(Array.isArray(job.hazards)).toBe(true);
    expect(job.title).toBe('Move a couch');
    expect(job.category).toBe('Moving');
    expect(job.pay).toBe(100);
  });

  it('degrades safely when the booking carries no job embed at all', () => {
    const job = fallbackJobFromBooking({ jobId: 'j1' });
    expect(job.id).toBe('j1');
    expect(job.title).toBeTruthy();
    expect(job.poster.name).toBeTruthy();
    expect(job.pay).toBe(0);
    expect(job.postedAt).toBeTruthy();
  });

  it('returns null without a jobId so callers can filter it out', () => {
    expect(fallbackJobFromBooking({})).toBeNull();
    expect(fallbackJobFromBooking(null)).toBeNull();
  });
});
