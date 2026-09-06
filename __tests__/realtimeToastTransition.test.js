// Realtime booking toasts must fire on a TRANSITION, not on the row's current status.
//
// Supabase realtime delivers an UPDATE for any column change on a row the subscriber
// can see — including that subscriber's own writes — and under the default REPLICA
// IDENTITY `payload.old` carries only the primary key. So a handler that decides which
// toast to show from `payload.new.status` alone re-announces old news: every time an
// earner tapped "I'm on site" (started_at) or "Mark done" (earner_done) on a booking
// that has been CONFIRMED for days, they were told "Booking Confirmed! The poster
// accepted your booking. Get ready!" again; rating the poster on a VERIFIED booking
// re-fired "Job Verified! … paid via card!" as if a second payment had landed; and a
// poster proposing an amendment on a COMPLETED booking was told an earner had just
// marked it complete, in response to their own tap.
//
// The fix is `enteredStatus(prev, next, target)` in shared/lifecycle.js, fed from the
// status the client already holds (stateRef). This guard pins both halves: the helper's
// semantics, and the fact that both clients actually route their toasts through it.

const fs = require('fs');
const path = require('path');
const { enteredStatus } = require('../shared/lifecycle.js');

const mobile = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'JobsContext.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'jobs.tsx'), 'utf8');

describe('enteredStatus — a transition, not a state', () => {
  test('true only when the row moves INTO the target status', () => {
    expect(enteredStatus('pending', 'confirmed', 'confirmed')).toBe(true);
    expect(enteredStatus('completed', 'verified', 'verified')).toBe(true);
  });

  test('false when the row was already in the target status (the defect)', () => {
    // The earner stamping started_at / earner_done on a booking already confirmed.
    expect(enteredStatus('confirmed', 'confirmed', 'confirmed')).toBe(false);
    // The earner rating the poster on a booking already verified.
    expect(enteredStatus('verified', 'verified', 'verified')).toBe(false);
    // The poster amending a booking already completed.
    expect(enteredStatus('completed', 'completed', 'completed')).toBe(false);
  });

  test('false when the row is in some other status entirely', () => {
    expect(enteredStatus('confirmed', 'completed', 'confirmed')).toBe(false);
    expect(enteredStatus(undefined, 'pending', 'verified')).toBe(false);
  });

  test('a row we hold no copy of counts as a transition (cold start is real news)', () => {
    expect(enteredStatus(undefined, 'confirmed', 'confirmed')).toBe(true);
    expect(enteredStatus(null, 'verified', 'verified')).toBe(true);
  });
});

describe('the realtime handlers gate every toast on a transition', () => {
  test('mobile reads the previously-held status from stateRef before dispatching', () => {
    expect(mobile).toMatch(/const prevStatus = stateRef\.current\.bookings\.find\(x => x\.id === b\.id\)\?\.status;/);
    expect(mobile).toMatch(/const prevStatus = stateRef\.current\.posterBookings\.find\(x => x\.id === payload\.new\?\.id\)\?\.status;/);
    expect(mobile).toContain("import { enteredStatus } from '../../shared/lifecycle.js';");
  });

  test('mobile earner-channel toasts go through enteredStatus', () => {
    expect(mobile).toContain("enteredStatus(prevStatus, b.status, 'confirmed')");
    expect(mobile).toContain("enteredStatus(prevStatus, b.status, 'verified')");
    expect(mobile).toContain("enteredStatus(prevStatus, b.status, 'declined')");
    // The bare current-status tests are what re-fired the toasts.
    expect(mobile).not.toMatch(/if \(b\.status === '(confirmed|verified|declined)'\)/);
  });

  test('mobile poster-channel "Job Marked Complete" goes through enteredStatus', () => {
    expect(mobile).toContain("enteredStatus(prevStatus, payload.new?.status, 'completed')");
    expect(mobile).not.toMatch(/payload\.new\?\.status === 'completed'/);
  });

  test('web mirrors the same gate on both channels', () => {
    expect(web).toMatch(/const prevStatus = stateRef\.current\.bookings\.find/);
    expect(web).toMatch(/const prevStatus = stateRef\.current\.posterBookings\.find/);
    expect(web).toContain('enteredStatus(prevStatus, next, "confirmed")');
    expect(web).toContain('enteredStatus(prevStatus, next, "verified")');
    expect(web).toContain('enteredStatus(prevStatus, next, "declined")');
    expect(web).toContain('"completed")');
    expect(web).not.toMatch(/if \(b\.status === "(confirmed|verified|declined)"\)/);
    expect(web).not.toMatch(/\)\?\.status === "completed"\)\n?\s*showToast/);
  });

  test('finalized bookings still cancel their local reminder unconditionally', () => {
    // Idempotent and safety-relevant: a verified/declined/cancelled booking must not
    // keep a pending "your gig starts in an hour" notification just because this
    // client already knew the status.
    expect(mobile).toMatch(/\['verified', 'declined', 'cancelled'\]\.includes\(b\.status\)\) cancelGigReminder\(b\.id\)/);
  });
});
