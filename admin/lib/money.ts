// What a payment row actually collected — and what survived the refunds.
//
// Three facts about `payments` make this arithmetic non-obvious, and all three have
// already produced a wrong number on a console screen:
//
//  1. `amount_cents` is the AUTHORIZED hold and is deliberately never rewritten
//     (stripe-capture-payment keeps it as the audit record), so it overstates a
//     partial capture.
//  2. The captured total is `earner_amount_cents + fee_cents`.
//  3. A refund does NOT move `status`. The column is CHECK-constrained to
//     authorized/captured/cancelled/failed (supabase/migration_stripe.sql), and
//     record_refund writes only refunded_cents / earner_refunded_cents / refunded_at.
//     A charge refunded in full therefore stays `captured` forever.
//
// So "what did we collect" is captured MINUS refunded, and nothing derives it for
// you. Any surface that prints a collected figure must subtract explicitly.

export type PaymentAmounts = {
  fee_cents?: number | null;
  earner_amount_cents?: number | null;
  refunded_cents?: number | null;
};

/** The gross captured total, as stripe-capture-payment records it. */
export function capturedCents(p: PaymentAmounts): number {
  return (p.earner_amount_cents ?? 0) + (p.fee_cents ?? 0);
}

/** Reversed back to the cardholder — admin refunds and chargebacks alike. */
export function refundedCents(p: PaymentAmounts): number {
  return p.refunded_cents ?? 0;
}

/**
 * Captured minus refunded. record_refund refuses a refund that would take
 * refunded_cents past the captured total, so this cannot go negative on real data;
 * the clamp is there so a hand-patched row prints $0.00 rather than a negative
 * dollar figure on the one page finance scans for collections.
 */
export function netCollectedCents(p: PaymentAmounts): number {
  return Math.max(0, capturedCents(p) - refundedCents(p));
}
