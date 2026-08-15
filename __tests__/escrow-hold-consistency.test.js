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

// Both of the blocks below explain, at length and in prose, the exact strings they
// forbid — `'cancelled'`, `'captured'`, a fresh `.select` on payments. Scanning the raw
// file would find those in the comments and pass (or fail) on documentation rather than
// on code. Four guards in this repo were satisfied by the prose explaining them.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/^\s*\/\/.*$/gm, ''); //    whole-line // comments

const readFn = (fn) => stripComments(fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', fn, 'index.ts'), 'utf8',
));

// Parse the argument list of a PostgREST `.in('status', [...])` predicate into plain
// status names, so a test can say which states are allowed without matching the
// surrounding quoting.
function statusPredicate(chain) {
  const m = chain.match(/\.in\('status',\s*\[([^\]]*)\]\)/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// accept-booking: everything before the write is a READ.
//
// The function retrieves the PaymentIntent from Stripe, requires 'requires_capture',
// then writes payments.status='authorized'. That write was keyed on the payment id
// alone while the booking confirm on the very next line was predicated — and the
// booking predicate does NOT close the gap, because declineBooking releases the hold
// BEFORE it writes 'declined', so for the whole of that window the booking is still
// 'pending' and the confirm matches. A release landing between the retrieve and the
// write therefore left the row claiming 'authorized' against a voided PaymentIntent,
// which is what both UIs, every escrow control and stripe-capture-payment read as
// "money is held".
//
// The predicate that fixes it is a knife-edge: 'failed' → 'authorized' is a CORRECT and
// load-bearing rewrite (declined card, poster retries on the same clientSecret, the
// retry is what makes the intent requires_capture), and excluding it would leave a live
// hold recorded as failed — which stripe-capture-payment refuses with HOLD_EXPIRED,
// stranding a poster who has genuinely paid. So this pins BOTH directions.
// ─────────────────────────────────────────────────────────────────────────────
describe('accept-booking: a released hold cannot be resurrected by an in-flight accept', () => {
  const ACCEPT = readFn('accept-booking');
  const payAt = ACCEPT.indexOf("update({ status: 'authorized' })");
  const bookAt = ACCEPT.indexOf("update({ status: 'confirmed' })");

  test('the re-authorize is predicated on the payment status', () => {
    expect(payAt).toBeGreaterThan(-1);
    const chain = ACCEPT.slice(payAt, ACCEPT.indexOf(';', payAt));
    const allowed = statusPredicate(chain);
    expect(allowed).not.toBeNull();

    // The retry path. Removing this is the regression that strands the poster.
    expect(allowed).toContain('failed');
    // Re-running an accept must stay a no-op rather than an error.
    expect(allowed).toContain('authorized');
    // The two that must never be resurrected: the hold is gone / the money moved.
    expect(allowed).not.toContain('cancelled');
    expect(allowed).not.toContain('captured');

    // Without asking for the matched rows back there is nothing to branch on.
    expect(chain).toMatch(/\.select\(/);
  });

  test('zero matched rows refuses the confirm instead of falling through', () => {
    expect(bookAt).toBeGreaterThan(payAt);
    const between = ACCEPT.slice(payAt, bookAt);
    // A confirmed booking with no hold behind it is free work — the whole reason this
    // function exists rather than being a client write.
    expect(between).toMatch(/length === 0/);
    expect(between).toMatch(/return json\(\{[\s\S]*?HOLD_RELEASED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripe-webhook payment_failed: the event payload is a snapshot, not the truth.
//
// Stripe redelivers on any non-2xx for ~3 days, and one PaymentIntent legitimately
// emits payment_failed and THEN reaches requires_capture (card declined, poster retries
// on the same clientSecret). The handler's status predicate is a precondition on our
// row, not on Stripe's, so a late event still matched an 'authorized' row: a live hold
// got stamped 'failed' and its confirmed booking demoted to 'pending' — which re-opens
// the slot to a second earner via sync_slot_taken and leaves capture refusing the
// funded booking with HOLD_EXPIRED.
// ─────────────────────────────────────────────────────────────────────────────
describe('stripe-webhook payment_failed: Stripe is asked before anything is demoted', () => {
  const WEBHOOK = readFn('stripe-webhook');
  const handler = WEBHOOK.slice(
    WEBHOOK.indexOf("case 'payment_intent.payment_failed'"),
    WEBHOOK.indexOf("case 'payment_intent.canceled'"),
  );
  const retrieveAt = handler.indexOf('paymentIntents.retrieve');
  const payAt = handler.indexOf("update({ status: 'failed' })");
  const bookAt = handler.indexOf("update({ status: 'pending' })");

  test('the intent is re-read before either demotion', () => {
    expect(handler.length).toBeGreaterThan(0);
    expect(retrieveAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(retrieveAt);
    expect(bookAt).toBeGreaterThan(retrieveAt);
  });

  test('a live or already-captured intent stops the handler', () => {
    const gate = handler.slice(retrieveAt, payAt);
    expect(gate).toMatch(/requires_capture/);
    expect(gate).toMatch(/succeeded/);
    expect(gate).toMatch(/break;/);
  });

  test('an unreadable Stripe writes nothing at all', () => {
    // Fail SAFE: the two mistakes do not cost the same. Demoting a live hold silently
    // strips a funded booking; skipping the demotion leaves a row the next accept, the
    // next event and reconcile-stripe all correct.
    const span = handler.slice(handler.indexOf('try {'), payAt);
    expect(span).toMatch(/catch/);
    expect(span).toMatch(/logServerError/);
    expect(span).toMatch(/break;/);
    expect(span).not.toMatch(/\.update\(/);
  });

  test('the booking demotion runs off the rows the payment update MATCHED', () => {
    const demote = handler.slice(payAt, bookAt);
    expect(demote).toMatch(/\.select\('booking_id'\)/);
    // The bug: a fresh re-select yields a booking_id whether or not the payment row was
    // actually demoted, so a 'captured' or 'cancelled' row the predicate correctly
    // skipped still dragged its booking back to 'pending'.
    expect(demote).not.toMatch(/from\('payments'\)\s*\.select\(/);

    const allowed = statusPredicate(demote);
    expect(allowed).not.toBeNull();
    expect(allowed).toContain('authorized');
    // Matching an already-'failed' row changes nothing on it, but the match is what
    // yields booking_id — so a Stripe REDELIVERY still repairs a first delivery that
    // died between the payment write and the booking write.
    expect(allowed).toContain('failed');
    expect(allowed).not.toContain('captured');
    expect(allowed).not.toContain('cancelled');
  });
});
