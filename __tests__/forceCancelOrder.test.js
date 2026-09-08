// ─────────────────────────────────────────────────────────────────────────────
// Force cancel must write the BOOKING before it voids money at Stripe.
//
// The console's forceCancel released the escrow hold first — an irreversible
// stripe.paymentIntents.cancel through admin-payment-action — and only then wrote
// bookings.status = 'cancelled'. That write can REFUSE: trg_guard_started_booking_cancel
// raises on `new.status = 'cancelled' and old.started_at is not null`, i.e. on every
// booking where the earner tapped "I'm on site".
//
// So the authorization was gone from Stripe, payments.status read 'cancelled', and the
// BOOKING stayed confirmed/completed and live for both parties with nothing behind it.
// From that moment capture, settle and earner-claim-payment were all impossible — and no
// control looks for that shape (ctl_settled_without_captured_payment only fires on a
// confirmed/completed booking with NO payments row; this one has a row).
//
// Both orders can strand something. The one we want strands the RECOVERABLE half:
// a cancelled booking with a live hold is caught by ctl_money_exposed_on_dead_booking
// after 6 hours, is fixed by the "Release hold" button on the same panel, and expires at
// Stripe in ~7 days regardless. JobsContext.cancelBooking has always written in this
// order and says why at src/context/JobsContext.js — this pins the console to it.
//
// None of this is reachable from a unit test: it lives in a Next.js server action against
// Supabase and Stripe. So assert on the source, the way escrow-hold-consistency.test.js
// pins the edge function it cannot run.
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
const GUARD = fs.readFileSync(
  path.join(
    __dirname, '..', 'supabase', 'migrations',
    '20260905005000_force_cancel_voided_the_hold_then_could_not_cancel.sql',
  ),
  'utf8',
);

// The body of one exported server action, so a match inside a SIBLING action (releaseHold
// calls release_hold too) can never satisfy an assertion about this one.
function bodyOf(name) {
  const start = ACTIONS.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf('\nexport async function ', start + 1);
  return ACTIONS.slice(start, next === -1 ? ACTIONS.length : next);
}

describe('forceCancel: the guarded write comes before the irreversible Stripe call', () => {
  const body = bodyOf('forceCancel');

  test('the bookings update is ordered BEFORE release_hold', () => {
    const write = body.indexOf('.update({ status: "cancelled" })');
    const release = body.indexOf('op: "release_hold"');
    expect(write).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(-1);
    // The whole finding, in one comparison.
    expect(write).toBeLessThan(release);
  });

  test('the failure message that could only exist in the wrong order is gone', () => {
    // "Hold released but the booking update failed" was the report an operator got while
    // the poster's authorization was already void and the gig was still live.
    expect(ACTIONS).not.toMatch(/Hold released but the booking update failed/);
  });

  test('a refused write reports that nothing moved, and names the started case', () => {
    expect(body).toMatch(/Nothing was changed and no money moved/);
    expect(body).toMatch(/clear "started" first/);
  });

  test('started_at is read, so the refusal can be explained', () => {
    expect(body).toMatch(/\.select\("status, started_at"\)/);
  });

  test('a hold left live after the cancel is reported as actionable, not as a plain failure', () => {
    expect(body).toMatch(/The booking is CANCELLED but the escrow hold could NOT be released/);
    expect(body).toMatch(/press "Release hold" now/);
  });

  test('the captured and fail-closed refusals still run before anything is written', () => {
    const write = body.indexOf('.update({ status: "cancelled" })');
    expect(body.indexOf('already CAPTURED')).toBeLessThan(write);
    expect(body.indexOf("Couldn't check whether this booking has an escrow hold")).toBeLessThan(write);
  });
});

describe('the started guard is scoped to the parties, not removed', () => {
  test('the migration adds the service_role early return', () => {
    expect(GUARD).toMatch(/create or replace function public\.guard_started_booking_cancel\(\)/);
    const fn = GUARD.slice(GUARD.indexOf('create or replace function public.guard_started_booking_cancel()'));
    const bypass = fn.indexOf("auth.role(), '') = 'service_role'");
    const raise = fn.indexOf('Cannot cancel a job that has already started');
    expect(bypass).toBeGreaterThan(-1);
    // The rule itself must survive, and the bypass must come first or it never applies.
    expect(raise).toBeGreaterThan(-1);
    expect(bypass).toBeLessThan(raise);
  });

  test('the raise still keys on the same condition', () => {
    expect(GUARD).toMatch(/new\.status = 'cancelled' and old\.started_at is not null/);
  });

  test('the probe proves both halves on one staged row', () => {
    // An operator gets through...
    expect(GUARD).toMatch(/FIX FAILED: the console override still cannot cancel a started booking/);
    // ...and a party still does not.
    expect(GUARD).toMatch(/REGRESSION: a party cancelled a started booking/);
  });
});

describe('the panel tells the operator what they are overriding', () => {
  test('Force cancel is still reachable on a started booking', () => {
    // Hiding it would only push the operator through "Clear started" — the same
    // override with an extra step and no extra thought.
    // Assert the INTENT — `startedAt` must not gate the button — rather than pinning the
    // whole expression. The literal form broke when 20260909140000 added
    // `|| Boolean(openDispute)`, which is a legitimate and different reason to disable:
    // over a live adjustment the action refuses before it writes, so offering the button
    // would only produce the refusal. Pinning the string made this test object to a
    // condition it has no opinion about.
    const i = PANEL.indexOf('forceCancel', PANEL.indexOf('export default'));
    expect(i).toBeGreaterThan(-1);
    const btn = PANEL.slice(i - 500, i);
    expect(btn).toMatch(/disabled=\{[^}]*status === "cancelled"/);
    expect(btn).not.toMatch(/disabled=\{[^}]*startedAt/);
  });

  test('the confirm branches on startedAt', () => {
    expect(PANEL).toMatch(/startedAt\s*\?\s*"The earner marked/);
  });
});
