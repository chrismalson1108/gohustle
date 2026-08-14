// ─────────────────────────────────────────────────────────────────────────────
// The capture path must CLAIM the payment row before it moves money, and must write
// back what Stripe actually collected.
//
// It used to do neither. The split was persisted with `.eq('id', …)` alone — no status
// predicate, no returned-row check — ahead of an irreversible Stripe call:
//
//   R1 (full)  writes the full split
//   R2 (50%)   writes the reduced split
//   R1         captures the FULL amount, flips status to 'captured'
//   credit_earnings credits the REDUCED figure it finds on the row
//
// and the mirror, which is worse: Stripe collects half while the row still holds the
// full split, so the poster pays $50 and the earner is told they were paid $100.
// credit_earnings is exactly-once but value-blind, and both ctl_payment_ledger_impossible
// and ctl_earnings_total_drift derive their expected value from the same column they
// would need to distrust — so nothing in the database can see it.
//
// Two properties, and this file fails if either is dropped:
//   1. every pre-capture write is conditional on status='authorized' and checks that it
//      matched a row (accept-booking:83 has done this since it was written);
//   2. the split is re-derived from pi.amount_received before the status flip, because
//      that flip is what lets credit_earnings run.
//
// The proportional rule is asserted to be the SAME one stripe-webhook applies. Two
// handlers deciding a different split for one PaymentIntent is how a ledger and its
// money stop agreeing.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const capture = fs.readFileSync(path.join(FN, 'stripe-capture-payment', 'index.ts'), 'utf8');
const webhook = fs.readFileSync(path.join(FN, 'stripe-webhook', 'index.ts'), 'utf8');
const accept = fs.readFileSync(path.join(FN, 'accept-booking', 'index.ts'), 'utf8');

const lines = capture.split('\n');
const lineOf = (needle, from = 0) => {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i;
  return -1;
};
const allLines = (needle) =>
  lines.reduce((acc, l, i) => (l.includes(needle) ? [...acc, i] : acc), []);

describe('capture claims the row before the Stripe call', () => {
  it('claimForCapture is a compare-and-swap, not a blind write', () => {
    const body = capture.slice(
      capture.indexOf('async function claimForCapture'),
      capture.indexOf('function reconcileToStripe'),
    );
    expect(body).toContain(".eq('status', 'authorized')");
    expect(body).toContain(".select('id')");
    // A claim that cannot tell "I matched a row" from "the query errored" is not a
    // claim. Both must resolve to false.
    expect(body).toMatch(/return\s+!error\s+&&\s+Array\.isArray\(data\)\s+&&\s+data\.length === 1/);
  });

  it('uses the same shape accept-booking already used for booking state', () => {
    // Named so a future reader finds the precedent rather than reinventing it.
    expect(accept).toContain(".eq('status', 'pending')");
    expect(accept).toContain('BOOKING_CHANGED');
  });

  it('every capture call is preceded by a claim that refuses on 0 rows', () => {
    const captures = allLines('stripe.paymentIntents.capture(');
    expect(captures.length).toBe(2); // partial + full branch
    for (const at of captures) {
      const window = lines.slice(Math.max(0, at - 12), at).join('\n');
      expect({ line: at + 1, window }).toEqual(
        expect.objectContaining({ window: expect.stringContaining('claimForCapture(') }),
      );
      expect(window).toContain('BOOKING_CHANGED');
      expect(window).toMatch(/}, 409\);/);
    }
  });

  it('no pre-capture write to payments bypasses the claim', () => {
    // The regression shape: `.from('payments').update({ fee_cents … })` inline, ahead
    // of a capture, with only an id predicate. All such writes must go through the
    // helper now.
    const firstCapture = lineOf('stripe.paymentIntents.capture(');
    const helperEnd = lineOf('const corsHeaders');
    const inlineWrites = allLines(".from('payments').update(")
      .filter((i) => i > helperEnd && i < firstCapture);
    expect(inlineWrites.map((i) => `${i + 1}: ${lines[i].trim()}`)).toEqual([]);
  });
});

describe('capture reconciles the ledger to what Stripe collected', () => {
  it('reads amount_received off the capture response', () => {
    const body = capture.slice(
      capture.indexOf('function reconcileToStripe'),
      capture.indexOf('const corsHeaders'),
    );
    expect(body).toContain('pi.amount_received');
    // A zero/absent figure must not zero out a real payout.
    expect(body).toMatch(/received <= 0/);
  });

  it('reconciles BEFORE the status flip that lets credit_earnings run', () => {
    for (const flip of allLines("status: 'captured',")) {
      const before = lines.slice(0, flip).join('\n');
      expect(before).toContain('reconcileToStripe(');
      // and the flip must carry the reconciled values, not leave the pre-write standing
      const stmt = lines.slice(flip, flip + 5).join('\n');
      expect(stmt).toContain('settled.feeCents');
      expect(stmt).toContain('settled.earnerCents');
    }
  });

  it('applies the same proportional rule as the webhook', () => {
    // Both compute fee' = min(received, round(fee * pct)) with pct capped at 1.
    const norm = (s) => s.replace(/\s+/g, '');
    for (const src of [capture, webhook]) {
      expect(norm(src)).toContain(norm('Math.min(1, received / '));
      expect(norm(src)).toMatch(/Math\.min\((received|receivedCents)?,?Math\.round\(/);
    }
  });

  it('logs an out-of-band amount instead of silently absorbing it', () => {
    expect(capture).toContain('Split re-derived from amount_received');
    expect(capture).toContain('logServerError');
  });
});
