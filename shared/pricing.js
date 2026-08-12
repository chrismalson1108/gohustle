// Platform fee arithmetic, shared by mobile and web.
//
// THE SERVER IS AUTHORITATIVE. Nothing here is ever sent to the backend or trusted by
// it — a client that computed its own fee and submitted it would be the whole security
// hole this design exists to close. These functions exist so the apps can SHOW the
// user what they will pay or receive before they commit, and they must agree with the
// server to the cent or the disclosure is a lie.
//
// The authority is public.platform_fee_cents (supabase/migrations/20260806050000).
// This file mirrors it, and __tests__/pricing.test.js parses that migration and fails
// if the two ever drift — the same guard categories.test.js applies to category_slug.
// If you change one, change the other, or the test will tell you.

export const DEFAULT_FEE_BPS = 1000; // 10.00% — the founding rate, and the fallback

// Mirrors coalesce(p_fee_bps, 1000) in the SQL. Anything not a usable number becomes
// the default rate — NEVER zero. A missing rate must degrade to "we charge our normal
// fee", not to "this one is free".
function coerceBps(feeBps) {
  if (feeBps === null || feeBps === undefined) return DEFAULT_FEE_BPS;
  const n = Number(feeBps);
  return Number.isFinite(n) ? Math.trunc(n) : DEFAULT_FEE_BPS;
}

// Stripe's own cost on a card charge, plus the margin that keeps a fee-free gig from
// settling at a loss. Mirrors the floor inside platform_fee_cents.
const STRIPE_PCT = 0.029;
const STRIPE_FIXED_CENTS = 30;
const PLATFORM_FLOOR_MARGIN_CENTS = 25;

/**
 * Fee in cents for an amount at a rate in basis points.
 *
 * Rounds HALF UP, matching the SQL. The obvious `(amount * bps) / 10000` truncates,
 * and on a $10.05 gig at 10% that is 100c where the server says 101c — a one-cent
 * disagreement that would only ever appear on odd amounts, in production.
 */
export function platformFeeCents(amountCents, feeBps = DEFAULT_FEE_BPS) {
  const amt = Number.isFinite(Number(amountCents)) ? Math.max(0, Math.trunc(Number(amountCents))) : 0;
  // `feeBps = DEFAULT_FEE_BPS` only fires on undefined, and Number(null) is 0 — which
  // IS finite, so a null rate silently became 0 bps and the fee fell to the processing
  // floor. That is the fail-open-to-nearly-free case this whole design exists to
  // prevent, and the SQL avoids it with coalesce(p_fee_bps, 1000). Match it explicitly.
  const bps = coerceBps(feeBps);
  const pct = Math.trunc((amt * bps + 5000) / 10000);
  const floor = Math.ceil(amt * STRIPE_PCT) + STRIPE_FIXED_CENTS + PLATFORM_FLOOR_MARGIN_CENTS;
  return Math.max(0, Math.min(amt, Math.max(pct, floor)));
}

/** What the earner actually receives. The fee comes out of THEIR side. */
export function earnerNetCents(amountCents, feeBps = DEFAULT_FEE_BPS) {
  const amt = Number.isFinite(Number(amountCents)) ? Math.max(0, Math.trunc(Number(amountCents))) : 0;
  return amt - platformFeeCents(amt, coerceBps(feeBps));
}

/**
 * Display label for a rate. Deliberately not "10%" hardcoded anywhere in the UI —
 * a label that can go stale is how prose ends up contradicting the charge.
 */
export function feeLabel(feeBps = DEFAULT_FEE_BPS) {
  const bps = coerceBps(feeBps);
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2).replace(/0$/, '')}%`;
}
