// A booking's counterparty must not be resolved through the browse feed alone.
//
// fetchJobs loads at most the 200 newest non-cancelled gigs platform-wide, and the code
// already knows a booked gig can fall outside that window — `bookedJobs` synthesises a
// card via fallbackJobFromBooking for exactly that case. But bookJob, startJob,
// markEarnerDone, cancelBooking and respondToAmendment resolved the poster to notify
// with `state.jobs.find(...)?.posterId` and nothing else. Every one of those sites is a
// `if (posterId) notify(...)`, so a miss is a silent no-op: the earner taps "I'm on
// site" and later "Mark done" on a three-week-old gig, both writes succeed, and the
// poster is never told the work is finished — they sit unaware until the ghost-claim
// grace window while the earner waits on "waiting for poster".
//
// The same lookup fed refreshUnread's blocked-party filter, so a conversation whose gig
// is off-feed could not be excluded — the phantom badge that filter exists to prevent.
//
// The booking row already carries the answer: both booking selects request
// `job.poster_id` and transformBooking exposes it as `job.posterId`.

const fs = require('fs');
const path = require('path');
const { bookingPosterId } = require('../shared/lifecycle.js');

const mobile = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'JobsContext.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'jobs.tsx'), 'utf8');
const transforms = fs.readFileSync(path.join(__dirname, '..', 'shared', 'transforms.js'), 'utf8');

const FEED = [{ id: 'job-in-feed', posterId: 'poster-A' }];

describe('bookingPosterId', () => {
  test('prefers the browse-feed row when the gig is listed', () => {
    const b = { jobId: 'job-in-feed', job: { posterId: 'stale-B' } };
    expect(bookingPosterId(b, FEED)).toBe('poster-A');
  });

  test('falls back to the booking embed when the gig is off-feed (the defect)', () => {
    // Soft-deleted by the poster, or simply older than the 200 newest gigs.
    const b = { jobId: 'job-removed', job: { posterId: 'poster-C' } };
    expect(bookingPosterId(b, FEED)).toBe('poster-C');
  });

  test('null — never undefined — when neither source has it', () => {
    expect(bookingPosterId({ jobId: 'x', job: null }, FEED)).toBeNull();
    expect(bookingPosterId(null, FEED)).toBeNull();
    expect(bookingPosterId({ jobId: 'job-removed', job: { posterId: 'poster-C' } }, null)).toBe('poster-C');
  });
});

describe('the embed the fallback depends on is actually selected and transformed', () => {
  test('transformBooking exposes job.posterId', () => {
    expect(transforms).toContain('posterId: b.job.poster_id || null');
  });

  test('both booking selects request poster_id', () => {
    const selects = mobile.match(/job:jobs!bookings_job_id_fkey\([^)]*\)/g) || [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    selects.forEach(s => expect(s).toContain('poster_id'));
  });
});

describe('no notify target is resolved through the feed alone', () => {
  test('mobile routes every booking→poster lookup through the helper', () => {
    expect(mobile).toContain("import { enteredStatus, bookingPosterId } from '../../shared/lifecycle.js';");
    // startJob / markEarnerDone / respondToAmendment / claimEarnerPayment / cancelBooking.
    expect((mobile.match(/bookingPosterId\(booking, state\.jobs\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(mobile).not.toMatch(/posterId = state\.jobs\.find\(j => j\.id === booking\?\.jobId\)\?\.posterId/);
  });

  test('mobile refreshUnread resolves the counterparty the same way, so the blocked filter can fire', () => {
    expect(mobile).toMatch(/const pid = bookingPosterId\(b, state\.jobs\);/);
  });

  test('mobile bookJob falls back to a direct lookup when the feed lacks the gig', () => {
    // Both the self-book guard and the "New booking request" push hang off this.
    expect(mobile).toMatch(/const job = state\.jobs\.find\(j => j\.id === jobId\) \|\| \(await fetchJobById\(jobId\)\);/);
  });

  test('web mirrors all of it', () => {
    expect(web).toContain('bookingPosterId } from "@gohustlr/shared"');
    expect((web.match(/bookingPosterId\(booking, state\.jobs\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(web).not.toMatch(/posterId = state\.jobs\.find\(\(j\) => j\.id === booking\?\.jobId\)\?\.posterId/);
    expect(web).toMatch(/const job = state\.jobs\.find\(\(j\) => j\.id === jobId\) \|\| \(await fetchJobById\(jobId\)\);/);
  });

  test('the cancellation-fee quote and the cancel itself answer for the same poster', () => {
    // cancellationFeeFor drives the confirm dialog. If it kept the feed-only test while
    // cancelBooking gained the fallback, an off-feed gig would be quoted $0 and then
    // recorded with a fee.
    expect(mobile).toMatch(/if \(bookingPosterId\(booking, state\.jobs\) !== user\?\.id\) return 0;/);
    expect(web).toMatch(/if \(bookingPosterId\(booking, state\.jobs\) !== user\?\.id\) return 0;/);
  });
});
