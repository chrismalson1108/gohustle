// ─────────────────────────────────────────────────────────────────────────────
// When a guard refuses a booking, the earner is told what to do about it.
//
// 20260906033000 added guard_booking_requires_slot, which refuses a slot-less booking
// on a gig that has slots and raises a sentence written for the person reading it:
// "This gig is booked through its time slots — pick an available one." The client
// swallowed it. bookJob logged the error to the console, returned false, and
// JobDetailScreen showed "That gig could not be booked. Please try again." — which
// sends the earner round the same loop with nothing to change, on the one gig where
// there IS something to change.
//
// This is the adjacent cost of adding a server-side guard: the refusal only helps if
// it arrives. Checked here rather than left to the next person to notice.
//
// SCOPE, deliberately narrow: only SQLSTATE 23514 (check_violation) is surfaced. On
// this table that code only ever comes from our own guards raising
// `using errcode = 'check_violation'` with human-written text. Every other code —
// RLS 42501, unique 23505, FK 23503 — carries Postgres-internal wording that would be
// noise at best and a leak at worst, so those keep the generic line.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ctx = strip(read('src/context/JobsContext.js'));
const screen = strip(read('src/screens/JobDetailScreen.js'));

describe('a refused booking tells the earner why', () => {
  it('the guard raises a check_violation carrying a sentence for the earner', () => {
    const mig = read('supabase/migrations/20260906033000_a_gig_whose_only_slot_is_taken_still_books.sql');
    expect(mig).toMatch(/using errcode = 'check_violation'/);
    expect(mig).toMatch(/This gig is booked through its time slots/);
  });

  it('bookJob captures the message only for our own guard code', () => {
    expect(ctx).toMatch(/error\.code === '23514'/);
    expect(ctx).toMatch(/lastBookingErrorRef\.current = error\.message/);
  });

  it('it is cleared at the start of every attempt', () => {
    // Otherwise a later, unrelated failure inherits the previous refusal's wording.
    const fn = ctx.slice(ctx.indexOf('const bookJob = async'), ctx.indexOf('const bookJob = async') + 400);
    expect(fn).toMatch(/lastBookingErrorRef\.current = null/);
  });

  it('is carried by a ref, not state, because the caller reads it immediately', () => {
    // A setState would not have landed by the line after `await bookJob(…)`, so the
    // toast would show the previous attempt's message or none at all.
    expect(ctx).toMatch(/const lastBookingErrorRef = useRef\(null\)/);
    expect(ctx).not.toMatch(/const \[lastBookingError, setLastBookingError\]/);
  });

  it('bookJob still returns a plain boolean', () => {
    // The call site is `if (!ok)`. Widening the return to an object would make every
    // failure truthy and silently turn a refused booking into a successful one.
    expect(ctx).toMatch(/const bookJob = async[\s\S]{0,4000}?return false;/);
    expect(ctx).not.toMatch(/const bookJob = async[\s\S]{0,4000}?return \{ ok:/);
  });

  it('the accessor is exported from the context', () => {
    expect(ctx).toMatch(/getLastBookingError,/);
  });

  it('the screen prefers the server sentence and keeps a fallback', () => {
    const branch = screen.slice(screen.indexOf('if (!ok) {'), screen.indexOf('if (!ok) {') + 700);
    expect(branch).toMatch(/getLastBookingError\?\.\(\)/);
    expect(branch).toMatch(/reason \|\| 'That gig could not be booked\. Please try again\.'/);
  });

  it('the screen actually pulls the accessor out of the context', () => {
    // Without this the optional call silently no-ops and every refusal reads generic —
    // the exact failure this guard exists to prevent, one step later.
    expect(screen).toMatch(/useJobs\(\)/);
    expect(screen).toMatch(/getLastBookingError[\s\S]{0,200}useJobs\(\)/);
  });
});
