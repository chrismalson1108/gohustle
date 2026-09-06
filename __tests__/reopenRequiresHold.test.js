// ─────────────────────────────────────────────────────────────────────────────
// Re-open must not confirm a booking with no escrow behind it.
//
// `confirmed` means one thing on this platform: a real Stripe authorization is held
// against the work. That is the entire reason accept-booking is a service-role edge
// function instead of a client write — it confirms ONLY after re-fetching the
// PaymentIntent and seeing `requires_capture`. guard_bookings_write early-returns for
// service_role, so nothing in the database re-checks the invariant for the console.
//
// reopenBooking wrote `status: 'confirmed'` for every status except verified and
// cancelled, reading only bookings.status and never payments. It refused `cancelled`
// with the invariant spelled out — "re-opening it would leave no escrow behind the
// work" — and then applied that reasoning to exactly one status. `pending` has no hold
// yet (it is minted when the poster accepts) and `declined` either never had one or had
// it voided by stripe-cancel-payment; the panel enabled Re-open for both.
//
// The failure is a person doing unpaid work: the booking flips to confirmed with a dead
// or absent PaymentIntent, the earner sees an active gig, and at verify
// stripe-capture-payment has nothing to capture while guard_bookings_write refuses
// completed→verified without a captured payment.
//
// The intended use is untouched — Re-open exists to undo a one-sided or forced
// `completed`, and capture only happens at verify, so those rows are 'authorized'.
//
// Server actions cannot be exercised from Jest, so pin the source, as
// escrow-hold-consistency.test.js and forceCancelOrder.test.js do.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ACTIONS = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'app', '(console)', 'bookings', 'actions.ts'),
  'utf8',
);
const PANEL = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'app', '(console)', 'bookings', '[id]', 'InterventionPanel.tsx'),
  'utf8',
);

// Isolate one exported action: forceCancel reads `payments` too, and a test that
// matched anywhere in the file would pass on the defect it is meant to catch.
function bodyOf(name) {
  const start = ACTIONS.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf('\nexport async function ', start + 1);
  return ACTIONS.slice(start, next === -1 ? ACTIONS.length : next);
}

describe('reopenBooking: no hold, no confirm', () => {
  const body = bodyOf('reopenBooking');

  test('it reads the payments row at all', () => {
    expect(body).toMatch(/\.from\("payments"\)\.select\("status"\)\.eq\("booking_id", bookingId\)/);
  });

  test('it refuses anything but a live authorization, so a missing row fails closed', () => {
    // `!== "authorized"` covers null/undefined — the pending case, which has no row.
    expect(body).toMatch(/pay\?\.status !== "authorized"/);
    // Never the inverse test, which would let a missing row through.
    expect(body).not.toMatch(/pay\?\.status === "cancelled"/);
  });

  test('the refusal explains what the operator has to do instead', () => {
    expect(body).toMatch(/no live escrow hold behind this booking/i);
    expect(body).toMatch(/The poster has to accept it again/);
  });

  test('the hold check runs BEFORE the status is written', () => {
    const check = body.indexOf('pay?.status !== "authorized"');
    const write = body.indexOf('.update({ status: "confirmed"');
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(check).toBeLessThan(write);
  });

  test('a failed payments lookup stops the action rather than reading as "no hold"', () => {
    // Same fail-closed shape forceCancel uses: a timed-out lookup must not be
    // interpreted as an answer in either direction.
    expect(body).toMatch(/Couldn't check whether this booking still has an escrow hold/);
  });

  test('the terminal statuses are still refused for their own reasons', () => {
    expect(body).toMatch(/A verified booking has already been paid out/);
    expect(body).toMatch(/re-opening it would leave no escrow behind the work/);
  });
});

describe('the panel does not invite the operator into that refusal', () => {
  test('Re-open follows the money, not only the status', () => {
    expect(PANEL).toMatch(
      /disabled=\{pending \|\| settled \|\| status === "cancelled" \|\| paymentStatus !== "authorized"\}/,
    );
  });

  test('and says why it is disabled', () => {
    expect(PANEL).toMatch(/No live escrow hold behind this booking/);
  });
});
