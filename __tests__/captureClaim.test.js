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

// ─────────────────────────────────────────────────────────────────────────────
// A dispute row must record a capture that HAPPENED, not one that was requested.
//
// The insert was gated on `capturePctFinal < 1` — the caller's own pct — while the
// booking gate admits 'verified'. So a poster could POST {pct: 0.5, disputeReason: '…'}
// at their OWN fully-settled booking and fabricate a "50% paid" dispute. No money moves
// (capture is skipped on an already-captured payment and credit_earnings is idempotent),
// which is exactly why it went unnoticed — the damage is elsewhere:
//
//   · vest_bonuses holds a referral bonus while ANY open dispute exists on the source
//     booking, so it freezes money belonging to a THIRD PARTY who cannot see or contest it
//   · it is a false entry in the only server-authored dispute log, rendered as fact on
//     three console pages
//   · ctl_dispute_open_beyond_sla opens a HIGH finding on it after 14 days
//
// capturedGigCents is the flag that means "a capture ran in THIS invocation" — it is
// assigned only inside the not-yet-captured block, and the settle call already used it.
// ─────────────────────────────────────────────────────────────────────────────
describe('the dispute row follows the capture, not the request', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', 'supabase', 'functions', 'stripe-capture-payment', 'index.ts'),
    'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('gates the insert on a capture having happened in this invocation', () => {
    expect(code).toMatch(/if \(capturedGigCents !== null && capturePctFinal < 1\)/);
    // The bare form is the bug: pct alone is the caller's claim.
    expect(code).not.toMatch(/if \(capturePctFinal < 1\) \{\s*\n\s*const \{ data: existingDispute/);
  });

  it('uses the same did-a-capture-run flag the benefit settle uses', () => {
    // Both consequences of a capture should hang off one fact, or they drift apart.
    expect(code).toMatch(/if \(capturedGigCents !== null\)/);
  });

  it('capturedGigCents is still assigned only inside the not-yet-captured block', () => {
    // If it were assigned unconditionally the flag would mean nothing and the gate above
    // would silently become a no-op.
    const guard = code.indexOf("if (payment.status !== 'captured')");
    const firstAssign = code.indexOf('capturedGigCents = ');
    expect(guard).toBeGreaterThan(-1);
    expect(firstAssign).toBeGreaterThan(guard);
  });
});
