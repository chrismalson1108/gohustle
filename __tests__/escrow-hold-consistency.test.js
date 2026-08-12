const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The escrow re-hold path, pinned textually.
//
// stripe-create-payment-intent computes ONE quantity — what Stripe actually holds —
// and uses it in four places: the reconcile comparison, the Stripe `amount`, the
// idempotency key, and the payments.amount_cents write. It was spelled out separately
// at each site, and when the poster discount landed two of them were updated and two
// were not.
//
// The result was deterministic and severe: with any poster discount the stored value
// (discounted) never equalled the compared value (pre-discount), so every second call
// took the "re-priced" branch and CANCELLED a live authorization hold — then recreated
// with an idempotency key that had not changed, so Stripe replayed the cached response
// and handed back the PaymentIntent it had just cancelled. The row recorded that dead
// intent as 'authorized'. The poster could not complete acceptance for 24 hours.
//
// None of that is reachable from the JS unit tests — it lives in a Deno edge function
// against Stripe. So assert on the source, the same way pricing.test.js parses the
// migrations off disk to stop JS and SQL drifting.
// ─────────────────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'stripe-create-payment-intent', 'index.ts'),
  'utf8',
);

describe('escrow hold: one quantity, one name', () => {
  test('the authorized amount is defined exactly once', () => {
    const defs = SRC.match(/const authorizedCents\s*=/g) ?? [];
    expect(defs).toHaveLength(1);
    // The name it replaced must be fully gone — a surviving chargeCents means a call
    // site was missed, which is precisely how this broke.
    expect(SRC).not.toMatch(/chargeCents/);
  });

  test('the reconcile comparison uses the same value that is persisted', () => {
    // What gets written to payments.amount_cents...
    expect(SRC).toMatch(/amount_cents:\s*authorizedCents/);
    // ...must be what the "has the price changed?" branch compares against.
    expect(SRC).toMatch(/existingPay\.amount_cents\s*===\s*authorizedCents/);
    // The pre-discount amount must NOT be what that branch compares.
    expect(SRC).not.toMatch(/existingPay\.amount_cents[^\n]*===\s*amountCents/);
  });

  test('Stripe is asked to hold the same value that is persisted', () => {
    expect(SRC).toMatch(/amount:\s*authorizedCents,/);
  });

  test('the idempotency key changes across a cancel-and-recreate', () => {
    const key = SRC.match(/idempotencyKey:\s*`([^`]+)`/);
    expect(key).not.toBeNull();
    const k = key[1];
    // The economic payload: reusing a key with different create parameters is an
    // outright Stripe error, and application_fee_amount is a create parameter.
    expect(k).toContain('${authorizedCents}');
    expect(k).toContain('${feeCents}');
    // The hold being replaced — this is what makes the key differ after a cancel,
    // so Stripe cannot replay the intent that was just killed.
    expect(k).toContain('${replacingPi}');
    // The bug: keyed on the pre-discount amount, which never changed.
    expect(k).not.toMatch(/\$\{amountCents\}/);
  });

  test('replacingPi is read from the row, not only from the cancel branch', () => {
    // Derived unconditionally, so a crash between create and the payments upsert
    // rebuilds the SAME key on retry and replays rather than orphaning a hold.
    expect(SRC).toMatch(/const replacingPi = existingPay\?\.payment_intent_id \?\? 'new'/);
  });

  test('a cancelled hold is marked dead before the replacement is created', () => {
    // Between the cancel and the upsert the row otherwise still claimed 'authorized'
    // against a dead intent, which is what accept-booking and the escrow controls read.
    const branch = SRC.slice(SRC.indexOf('Amount changed (re-priced)'));
    expect(branch.slice(0, 700)).toMatch(/status:\s*'cancelled'/);
  });
});
