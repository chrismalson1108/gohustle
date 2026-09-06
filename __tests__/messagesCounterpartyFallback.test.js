// A conversation must never be hidden by the inbox while the tab badge still counts it.
//
// MessagesScreen resolved the counterparty of an EARNER-side conversation only from the
// in-memory browse feed (`jobs.find(...)?.poster`). fetchJobs excludes status='cancelled'
// gigs and caps the feed at 200 rows, so for any booking whose gig the poster soft-
// deleted — or that has simply aged past the cap — `other` came back null and the row was
// dropped by `.filter(c => c.lastMsg && c.other && ...)` entirely. JobsContext.refreshUnread
// counted those same bookings, so the Messages tab showed an unread badge for a
// conversation the Messages screen refused to list, the push for that message deep-linked
// into an empty inbox, and the thread could never be marked read.
//
// It is reachable both ways: a poster may delete a gig whose only bookings are pending
// (EditJobScreen's isLocked covers only confirmed/completed/verified) and then message the
// applicant from the phantom card on the Hire tab, and a poster may delete a finished gig
// from GigsScreen, taking the earner's chat history out of their inbox.
//
// Web already fell back to `b.job?.posterId` for exactly this case; mobile now does too,
// through the same bookingPosterId resolver JobsContext uses, so the inbox and the badge
// cannot disagree about who a conversation is with.

jest.mock('../src/lib/supabase', () => ({ supabase: {} }));
const fs = require('fs');
const path = require('path');
const { notBlocked } = require('../src/lib/messages');
const { bookingPosterId } = require('../shared/lifecycle.js');

const screen = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'MessagesScreen.js'), 'utf8');
const jobsCtx = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'JobsContext.js'), 'utf8');
const webPage = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', '(app)', 'messages', 'page.tsx'), 'utf8');

describe('the resolver behind the inbox row', () => {
  const feed = [{ id: 'job-live', posterId: 'poster-1' }];

  test('a removed / aged-out gig still yields a counterparty', () => {
    const booking = { id: 'b1', jobId: 'job-gone', job: { title: 'Yard work', posterId: 'poster-2' } };
    expect(bookingPosterId(booking, feed)).toBe('poster-2');
  });

  test('the listed gig still wins when it is in the feed', () => {
    const booking = { id: 'b2', jobId: 'job-live', job: { posterId: 'poster-2' } };
    expect(bookingPosterId(booking, feed)).toBe('poster-1');
  });

  test('a resolved counterparty is what makes the block filter able to fire', () => {
    // With `other` null the row was dropped for the wrong reason and the badge kept
    // counting it; with an id, blocking hides it in BOTH places.
    const other = { id: bookingPosterId({ jobId: 'job-gone', job: { posterId: 'poster-2' } }, feed) };
    expect(notBlocked({ other }, new Set(['poster-2']))).toBe(false);
    expect(notBlocked({ other }, new Set(['someone-else']))).toBe(true);
  });
});

describe('MessagesScreen earner branch', () => {
  test('falls back to the booking embed instead of dropping the row', () => {
    expect(screen).toMatch(/import \{ bookingPosterId \} from '\.\.\/\.\.\/shared\/lifecycle';/);
    expect(screen).toMatch(/const posterId = bookingPosterId\(eb, jobs\);/);
    // The old shape — a bare conditional on the feed's job — must be gone.
    expect(screen).not.toMatch(/other = job\?\.poster \? \{[^}]*\} : null;/);
    expect(screen).toMatch(/: \(posterId \? \{ id: posterId, name: 'Poster', avatarInitial: 'P', avatarUrl: null \} : null\)/);
  });

  test('the placeholder name is enriched from profiles, and failing to do so keeps the row', () => {
    expect(screen).toMatch(/const missing = \[\.\.\.new Set\(list\.filter\(c => c\.namePending\)\.map\(c => c\.other\.id\)\)\];/);
    expect(screen).toContain("select('id, name, avatar_initial, avatar_url')");
    // Fails open: the catch must not clear the row or rethrow.
    expect(screen).toMatch(/\} catch \(_\) \{ \/\* keep the placeholder — a listed thread beats a hidden one \*\/ \}/);
  });

  test('inbox and badge share one resolver, so they cannot disagree', () => {
    expect(jobsCtx).toMatch(/const pid = bookingPosterId\(b, state\.jobs\);/);
    expect(screen).toMatch(/bookingPosterId\(eb, jobs\)/);
  });

  test('web keeps its own equivalent fallback (this is a parity fix, not a new idea)', () => {
    expect(webPage).toMatch(/otherId: job\?\.posterId \?\? b\.job\?\.posterId \?\? null/);
  });
});
