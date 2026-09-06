const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A staged book_gig lives for ten minutes before the user taps the card, and
// executeBooking used to insert straight from that payload. Two DIFFERENT unique
// constraints raise SQLSTATE 23505 on that insert:
//
//   bookings unique(job_id, earner_id)  — the user's own duplicate
//   bookings_one_active_per_slot        — somebody else took the slot meanwhile
//
// The handler treated every 23505 as the first, looked for the user's own prior
// booking, found none, and fell through to "You've already requested this gig." —
// telling the one user who does NOT have a request in that they do, and persisting
// that sentence into the thread. They stop looking; EarnScreen shows nothing.
//
// So: re-read the listing and the staged slot before inserting, and when the insert
// still loses the race, branch on the CONSTRAINT NAME rather than assuming.
// ─────────────────────────────────────────────────────────────────────────────
const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/assistant/index.ts'), 'utf8');

const start = fn.indexOf('async function executeBooking');
const body = fn.slice(start, fn.indexOf('async function myActivity'));

describe('confirming a staged booking re-checks the world it was staged in', () => {
  it('has an executeBooking body to read', () => {
    expect(start).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(200);
  });

  it('re-reads the listing status and its slots BEFORE inserting', () => {
    const insertAt = body.indexOf(".from('bookings')");
    const reread = body.indexOf('job_slots(id, label, taken, starts_at)');
    expect(reread).toBeGreaterThan(-1);
    expect(reread).toBeLessThan(insertAt);
    // The two states that can change under a waiting confirmation card.
    expect(body.slice(0, insertAt)).toMatch(/status !== 'open'/);
    expect(body.slice(0, insertAt)).toMatch(/taken/);
  });

  it('says the slot was taken, not that a request exists', () => {
    expect(body).toMatch(/slot_taken/);
    const takenBranch = body.slice(body.indexOf('slot_taken'));
    expect(takenBranch.slice(0, 400)).not.toMatch(/already requested/i);
  });

  it('branches on the constraint name when the insert loses the race', () => {
    // Without this the race is indistinguishable from a self-duplicate, which is
    // exactly how the false claim was produced.
    expect(body).toMatch(/bookings_one_active_per_slot/);
    const dupAt = body.indexOf('bookings_one_active_per_slot');
    const alreadyAt = body.indexOf("'already_booked'");
    expect(dupAt).toBeGreaterThan(-1);
    expect(alreadyAt).toBeGreaterThan(dupAt);
  });

  it('never claims a request exists without having read one', () => {
    // "You've already requested this gig." may only be reached from a branch that
    // has an actual prior status in hand.
    const claim = body.indexOf("You've already requested this gig.");
    expect(claim).toBeGreaterThan(-1);
    const preceding = body.slice(0, claim);
    // A guard that returns early when the prior lookup came back empty.
    expect(preceding).toMatch(/if \(!st\)/);
    expect(preceding).toMatch(/not_booked/);
  });
});
