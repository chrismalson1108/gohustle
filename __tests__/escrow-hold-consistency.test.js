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

// ─────────────────────────────────────────────────────────────────────────────
// The RECOVERY re-hold is the branch that most needs the reconcile, and it used to be
// the one branch that skipped it.
//
// The block above was gated on `existingPay.status === 'authorized'` — the exact
// complement of `isRecovery` (`status in ('cancelled','failed')`). So the path that
// declares the previous hold dead never asked Stripe whether it was, and fell through
// to paymentIntents.create with a deliberately different idempotency key. Since
// payment_intent_id is UNIQUE and the write upserts on booking_id, PI#1's id is
// overwritten and gone — and every money control is SQL over our own tables, while
// reconcile-stripe retrieves only the id named on the row, so the orphan is unreachable
// by construction.
//
// It needs no webhook race: card declines → payment_failed demotes the row keyed only
// on the PI id → the poster retries card B on the same clientSecret, making that PI
// requires_capture → accept-booking does not land → the row rests at 'failed' naming a
// LIVE hold → reopening Accept & pay holds the poster's card a second time.
// ─────────────────────────────────────────────────────────────────────────────
describe('escrow hold: our status column is a belief, Stripe is the fact', () => {
  test('the reconcile block is entered on the PI id alone, not on our status', () => {
    const guard = SRC.match(/if \(existingPay\?\.payment_intent_id[^)]*\) \{/);
    expect(guard).not.toBeNull();
    // The regression, named: re-adding any status predicate here re-opens the branch.
    expect(guard[0]).not.toMatch(/status/);
  });

  test('nothing re-gates the retrieve on our status between guard and call', () => {
    // The retrieve must be reachable from the recovery path. Moving the old predicate
    // one line down would satisfy the test above and re-introduce the bug, so assert
    // the span between the guard and the Stripe call is clean of status conditions.
    const at = SRC.indexOf("if (existingPay?.payment_intent_id");
    const to = SRC.indexOf('stripe.paymentIntents.retrieve(', at);
    expect(at).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(at);
    const span = SRC.slice(at, to)
      .replace(/^[ \t]*\/\/.*$/gm, ''); // the comment block above it explains the bug
    expect(span).not.toMatch(/existingPay[?.]*\.status/);
  });

  test('a row Stripe contradicts is healed, but only on requires_capture', () => {
    // Writing 'authorized' for a PI still awaiting a payment method would tell
    // expire_stale_pending_bookings and ctl_escrow_hold_lapsed_uncancelled that escrow
    // exists when nothing is held.
    const heal = SRC.slice(SRC.indexOf("existingPI.status === 'requires_capture'"));
    expect(heal.slice(0, 400)).toMatch(/status:\s*'authorized'/);
    expect(heal.slice(0, 400)).toContain('.eq(\'payment_intent_id\'');
  });
});
