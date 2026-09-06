// ─────────────────────────────────────────────────────────────────────────────
// A settlement's fee comes from what Stripe APPLIED, never from payments.fee_cents.
//
// fee_cents is mutable, and there is a live path that leaves it wrong on exactly the
// rows these two settlement paths are offered for. stripe-capture-payment's partial
// (dispute) branch calls claimForCapture — which writes the REDUCED split — BEFORE the
// Stripe capture (index.ts:325 then :331). If that capture throws, the terminal catch
// only logs: the row rests at status='authorized' carrying the reduced fee, and
// InterventionPanel enables "Settle & pay earner" on precisely that state.
//
//   $100 gig at 700 bps. A 50% attempt writes fee 350 / earner 4650, then the Stripe
//   call times out. Support later settles. Stripe captures 10000c and transfers 9300c
//   (the PaymentIntent's original application_fee_amount of 700). Reading fee_cents off
//   the row recorded fee 350 / earner 9650, and credit_earnings credited $96.50 for
//   money that was never sent — $3.50 of platform revenue given away, and the receipt
//   showing the wrong split on the one booking the poster is most likely to check.
//
// Nothing could see it. The two written values still sum to amount_received, so
// reconcile-stripe's captured_total_mismatch passes by construction, and
// ctl_earnings_total_drift compares profiles against the same inflated column.
//
// The webhook's succeeded handler had the identical exposure by scaling row.fee_cents
// for an out-of-band Dashboard capture.
//
// earner-claim-payment already got this right — "STRIPE is the sole source of truth" —
// by reading latest_charge.application_fee_amount. This pins all three together.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const read = (fn) => fs.readFileSync(path.join(FN, fn, 'index.ts'), 'utf8');
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const admin = read('admin-payment-action');
const webhook = read('stripe-webhook');
const claim = read('earner-claim-payment');
const capture = read('stripe-capture-payment');

// The settle op's body: from its guard to the next op.
const settle = stripComments(
  admin.slice(admin.indexOf("if (op === 'settle') {"), admin.indexOf("if (op === 'record_reversal') {")),
);

describe('admin settle takes the fee from Stripe', () => {
  test('found the settle op', () => {
    expect(settle.length).toBeGreaterThan(400);
    expect(settle).toMatch(/stripe\.paymentIntents\.capture\(/);
  });

  test('it expands the charge, where application_fee_amount lives', () => {
    expect(settle).toMatch(/expand: \['latest_charge'\]/);
    expect(settle).toMatch(/application_fee_amount/);
  });

  test('it never reads the mutable fee_cents column — the defect, verbatim', () => {
    expect(settle).not.toMatch(/pay\.fee_cents/);
    expect(settle).not.toMatch(/Math\.min\(received, pay\.fee_cents \?\? 0\)/);
  });

  test('the fallback recomputes from the PINNED inputs, not from the rate card', () => {
    // fee_bps / fee_credit_cents / poster_discount_cents are pinned at authorization by
    // trg_z_pin_payment_fee_bps, so a settlement weeks later is priced at the rate the
    // booking was struck at.
    expect(settle).toMatch(/platform_fee_after_credit/);
    expect(settle).toMatch(/p_fee_bps: safeBps\(pay\.fee_bps\)/);
    expect(settle).toMatch(/p_credit_cents: Math\.max\(0, Math\.trunc\(Number\(pay\.fee_credit_cents\)/);
    // The current standing rate must never enter this path.
    expect(settle).not.toMatch(/fee_bps_at|getFeeBps/);
  });

  test('the row is selected with the pinned columns the fallback needs', () => {
    const sel = /\.select\('id, payment_intent_id[^']*'\)/.exec(admin)[0];
    expect(sel).toContain('fee_bps');
    expect(sel).toContain('fee_credit_cents');
    expect(sel).toContain('poster_discount_cents');
  });

  test('it fails loud rather than writing a guessed split over real money', () => {
    expect(settle).toMatch(/fee_unknown/);
    expect(settle).toMatch(/fatal: true/);
  });
});

describe('the webhook re-derivation prefers the applied fee too', () => {
  const succeeded = stripComments(
    webhook.slice(
      webhook.indexOf("case 'payment_intent.succeeded':"),
      webhook.indexOf("case 'payment_intent.payment_failed':"),
    ),
  );

  test('found the handler and its mismatch branch', () => {
    expect(succeeded).toMatch(/received > 0 && received !== storedSplit/);
  });

  test('it asks Stripe what fee was applied before scaling anything', () => {
    expect(succeeded).toMatch(/expand: \['latest_charge'\]/);
    expect(succeeded).toMatch(/application_fee_amount/);
    expect(succeeded).toMatch(/appliedFee !== null/);
  });

  test('scaling the stored fee survives only as the unreachable-Stripe fallback', () => {
    // The old unconditional form is the bug: it scales a fee_cents that a failed
    // partial attempt may already have reduced.
    expect(succeeded).not.toMatch(
      /const fee = Math\.min\(received, Math\.round\(\(row\.fee_cents \?\? 0\) \* pct\)\);/,
    );
    expect(succeeded).toMatch(/: Math\.min\(received, Math\.round\(\(row\.fee_cents \?\? 0\) \* pct\)\)/);
  });
});

describe('all three settlement paths agree on the source of truth', () => {
  test('earner-claim-payment — the one that was already right — is unchanged', () => {
    expect(claim).toMatch(/expand: \['latest_charge'\]/);
    expect(claim).toMatch(/stripeFeeCents = typeof settledCharge\?\.application_fee_amount === 'number'/);
  });

  test('the stale-fee-cents window this defends against still exists in capture', () => {
    // If claimForCapture ever stops pre-writing the reduced split, or the terminal
    // catch starts restoring it, this whole class is gone and these guards can be
    // reconsidered. Until then, the precondition is real: the write precedes the
    // Stripe call, and the catch only logs.
    const claimAt = capture.indexOf('await claimForCapture(supabase, payment.id, feeCents, earnerAmountCents)');
    const captureAt = capture.indexOf('await stripe.paymentIntents.capture(payment.payment_intent_id, {');
    expect(claimAt).toBeGreaterThan(-1);
    expect(captureAt).toBeGreaterThan(claimAt);
    // Nothing puts fee_cents back on the way out.
    const terminal = capture.slice(capture.indexOf('} catch (err: any) {'));
    expect(terminal).not.toMatch(/fee_cents/);
  });
});
