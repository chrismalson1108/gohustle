const fs = require('fs');
const path = require('path');

// stripe-cancel-payment voids a Stripe hold and never writes to the bookings row.
// That is correct ONLY because it is the second half of decline/cancel: declineBooking
// calls it while the booking is still 'pending', and cancelBooking sets 'cancelled'
// first ("now it's safe to release the hold"). Nothing forced that pairing, and it is a
// plain authenticated endpoint — so a poster could accept a booking (escrow authorized,
// earner pushed "Booking accepted!", gig showing Active) and then call it directly.
// Every other guard passed: not completed/verified, started_at still null, payment
// still authorized. The hold vanished and the booking stayed 'confirmed', with neither
// client reading the payments table — so the earner did the work with nothing behind it.
//
// admin/lib/deleteUser.ts already declared the intended contract and said it "Mirrors
// the edge function". It didn't. This pins the two together so they cannot drift again.
const ROOT = path.join(__dirname, '..');
const EDGE = path.join(ROOT, 'supabase', 'functions', 'stripe-cancel-payment', 'index.ts');
const ADMIN = path.join(ROOT, 'admin', 'lib', 'deleteUser.ts');

function statusArray(src, name) {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .sort();
}

describe('stripe-cancel-payment may only void a hold on a non-live booking', () => {
  const edge = fs.readFileSync(EDGE, 'utf8');
  const admin = fs.readFileSync(ADMIN, 'utf8');

  test('the edge function declares CANCELLABLE_STATUSES', () => {
    expect(statusArray(edge, 'CANCELLABLE_STATUSES')).not.toBeNull();
  });

  test("a 'confirmed' booking's hold cannot be voided — the exploit", () => {
    // The whole finding in one assertion: 'confirmed' must NOT be cancellable.
    expect(statusArray(edge, 'CANCELLABLE_STATUSES')).not.toContain('confirmed');
  });

  test('it still permits the two legitimate flows', () => {
    const s = statusArray(edge, 'CANCELLABLE_STATUSES');
    // declineBooking calls this while the booking is still 'pending'; cancelBooking
    // sets 'cancelled' before calling. Both must keep working.
    expect(s).toContain('pending');
    expect(s).toContain('cancelled');
  });

  test('the edge function and the admin cascade agree on the set', () => {
    // admin/lib/deleteUser.ts says it mirrors this function. Make that true.
    expect(statusArray(edge, 'CANCELLABLE_STATUSES')).toEqual(
      statusArray(admin, 'CANCELLABLE_STATUSES'),
    );
  });

  test('the completed/verified refusal is still there', () => {
    // The pre-existing guard: once work is done the funds are the earner's.
    expect(edge).toMatch(/\['completed',\s*'verified'\]/);
  });
});
