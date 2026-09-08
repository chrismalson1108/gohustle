// ─────────────────────────────────────────────────────────────────────────────
// A reversed TIP is not a dispute on the escrow charge.
//
// recordReversal finds no payments row for a tip's PaymentIntent, falls back to
// tip_ledger, reverses the tip correctly — and then set `bookingId = tip.booking_id`
// and FELL THROUGH into the generic path, which files a disputes row against the
// BOOKING using the standard template:
//
//   'Stripe refund on charge ch_… (usd 20.00 refunded)'
//
// That is exactly the anchored template ctl_external_reversal_not_ledgered selects on.
// The control joins that row to the booking's CAPTURED escrow payment — a $100 gig
// Stripe never touched — and 24 hours later opens a HIGH money finding reading
// "reversal 2000, refunded 0, unledgered 2000". Its remedy says to press Record
// chargeback, "which writes refunded_cents". Doing so writes a reversal onto a charge
// that was never reversed: GMV and platform fees permanently misstated, a refund_ledger
// row for a chargeback that never happened, and reconcile-stripe stuck in a
// refund_mismatch it can never clear. The finding could not auto-resolve either —
// the only thing that would close it was that wrong write.
//
// The same row freezes a THIRD PARTY's money (vest_bonuses holds a referral bonus while
// any open dispute exists on the source booking) and trips ctl_dispute_open_beyond_sla
// at 14 days.
//
// Neither exemption in recordReversal could catch it: for a refund `row` is the null
// payments lookup, so `(row?.refunded_cents ?? 0) >= stripeRefundedCents` is false for
// any positive refund; the chargeback arm skips that block entirely.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const webhook = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf8',
);
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations',
    '20260906013200_a_reversed_tip_was_charged_to_the_escrow_payment.sql'), 'utf8',
);

// recordReversal's body, comments stripped.
const fn = webhook
  .slice(webhook.indexOf('async function recordReversal('), webhook.indexOf('Deno.serve('))
  .replace(/^\s*\/\/.*$/gm, '');

describe('the tip branch never reaches the booking-level dispute insert', () => {
  test('found recordReversal and its tip fallback', () => {
    expect(fn).toMatch(/record_tip_reversal/);
    expect(fn).toMatch(/from\('tip_ledger'\)/);
  });

  test('it returns the tip booking id instead of falling through', () => {
    expect(fn).toMatch(/return tip\.booking_id;/);
    // The fall-through, verbatim. This is the whole defect.
    expect(fn).not.toMatch(/bookingId = tip\.booking_id;/);
  });

  test('the return is inside the tip block, ahead of the dispute insert', () => {
    const tipReturn = fn.indexOf('return tip.booking_id;');
    const rpc = fn.indexOf("rpc('record_tip_reversal'");
    const insert = fn.indexOf("from('disputes').insert(");
    expect(rpc).toBeGreaterThan(-1);
    expect(tipReturn).toBeGreaterThan(rpc);
    expect(insert).toBeGreaterThan(tipReturn);
    // Nothing between the tip block's close and the insert can be entered from it: the
    // only way past `if (!bookingId) return null;` is a real payments row.
    expect(fn.slice(tipReturn, insert)).toMatch(/if \(!bookingId\) return null;/);
  });

  test('the tip is still reversed, and a failure is still paged', () => {
    // Returning early must not skip the ledger write — that is the thing this branch
    // exists for. Money leaving the platform balance while the earner keeps the credit
    // is invisible to ctl_earnings_total_drift's payments half.
    const tipBlock = fn.slice(fn.indexOf("from('tip_ledger')"), fn.indexOf('return tip.booking_id;'));
    expect(tipBlock).toMatch(/rpc\('record_tip_reversal'/);
    expect(tipBlock).toMatch(/fatal: true/);
  });

  test('the callers still get a booking id for the admin email', () => {
    // Both call sites print it; returning null would render "not matched — investigate
    // in Stripe" on a tip we matched perfectly well.
    expect(webhook).toMatch(/const bookingId = await recordReversal\(/);
    expect(webhook).toMatch(/bookingId \? esc\(bookingId\)/);
  });

  test('no tip-shaped reason is minted that the control could select', () => {
    // If a tip chargeback is ever wanted as an abuse signal it needs its OWN template,
    // one the control's two anchored regexes do not match. Until that decision is made,
    // there must be no third template at all.
    // A trailing `(%` is a SQL LIKE PATTERN, not a reason. markExternalStatus finds the
    // row this webhook already filed for a dispute by that prefix; it mints nothing, so
    // counting it as a third template would fail this test for the opposite of the reason
    // it exists. reversalReasonParity.test.js asserts the matcher and the writer stay in
    // step, which is the invariant that keeps that exclusion honest.
    const templates = (webhook.match(/`Stripe (refund on charge|chargeback) [^`]*`/g) ?? [])
      .filter((t) => !/\(%`$/.test(t));
    expect(templates).toHaveLength(2);
    for (const t of templates) expect(t).not.toMatch(/tip/i);
  });
});

describe('rows already filed no longer print a ledger-corrupting remedy', () => {
  test('the control excludes a reversal tip_ledger already accounts for', () => {
    expect(migration).toMatch(/from public\.tip_ledger t/);
    expect(migration).toMatch(/coalesce\(t\.reversed_cents, 0\) = d\.stated_cents/);
    expect(migration).toMatch(/and not exists \(/);
  });

  test('the exclusion is an EXACT amount match, never a blanket skip', () => {
    // A blanket "this booking has a reversed tip" would mask a genuine unledgered
    // escrow reversal, which is the one thing this control exists to catch.
    expect(migration).not.toMatch(/coalesce\(t\.reversed_cents, 0\) > 0\s*\n\s*\)/);
    expect(migration).toMatch(/d\.stated_cents is not null/);
  });

  test('the chargeback template has an amount to match on', () => {
    // reversal_cents is null for a chargeback by design — the control's null branch
    // depends on it — so the exclusion needed its own parse or it could never reach
    // that arm at all.
    expect(migration).toMatch(/as stated_cents/);
    expect(migration).toMatch(/, \[a-z\]\{3\} \(\[0-9\]\+\\\.\[0-9\]\{2\}\)\\\)\$/);
  });

  test('the two anchored selection regexes are untouched', () => {
    // reversalReasonParity.test.js pins these to the webhook's templates; a redefinition
    // that quietly narrowed them would blind the control instead of correcting it.
    expect(migration).toMatch(
      /\^Stripe refund on charge \(ch\|py\)_\[A-Za-z0-9\]\{8,\} \\\(\[a-z\]\{3\} \[0-9\]\+\\\.\[0-9\]\{2\} refunded\\\)\$/,
    );
    expect(migration).toMatch(
      /\^Stripe chargeback \(dp\|du\)_\[A-Za-z0-9\]\{8,\} \\\(\[\^\(\)\]\*, \[a-z\]\{3\} \[0-9\]\+\\\.\[0-9\]\{2\}\\\)\$/,
    );
  });

  test('the remedy warns the operator to check the charge is the escrow one', () => {
    expect(migration).toMatch(/must never move refunded_cents on the escrow payment/);
  });

  test('the probe proves both directions on the same booking', () => {
    expect(migration).toMatch(/FIX FAILED: a reversed TIP still opens a HIGH finding/);
    expect(migration).toMatch(/a real unledgered escrow refund on a booking that also had a reversed tip/);
    expect(migration).toMatch(/a tip CHARGEBACK still opens a finding against the escrow payment/);
  });
});
