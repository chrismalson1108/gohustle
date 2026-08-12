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

/**
 * Split the deduction into the part that is OURS and the part that is the card
 * network's, so a screen can be honest about a 0% fee.
 *
 * At 0 bps the deduction does not go to zero — platform_fee_cents floors at Stripe's
 * cost so a free gig never settles at a loss. Labelling that "0%" while the earner
 * watches $3.45 come off a $100 gig is the kind of small dishonesty that costs more
 * trust than the fee itself. This lets the UI say what is actually happening:
 *
 *     Platform fee    $0.00
 *     Card processing $3.20
 *     You receive    $96.80
 *
 * NOT a pure pass-through, and the split says so. The floor is
 * ceil(amount x 2.9%) + 30c + 25c, and only the first two are Stripe's — the last 25c
 * is ours. Folding it into "processing" would be a nicer story and a false one, so
 * processingCents is Stripe's real take and everything above it lands in platformCents,
 * including that 25c.
 *
 * Mirrors platform_fee_cents; the same migration-parsing test guards the drift.
 */
export function feeBreakdown(amountCents, feeBps = DEFAULT_FEE_BPS) {
  const amt = Number.isFinite(Number(amountCents)) ? Math.max(0, Math.trunc(Number(amountCents))) : 0;
  const bps = coerceBps(feeBps);
  const totalCents = platformFeeCents(amt, bps);
  // Capped at the total: on a very small gig platform_fee_cents clamps to the amount
  // itself, and processing must never be reported as more than was actually taken.
  const processingCents = Math.min(totalCents, Math.ceil(amt * STRIPE_PCT) + STRIPE_FIXED_CENTS);
  const nominalCents = Math.trunc((amt * bps + 5000) / 10000);
  return {
    totalCents,
    processingCents,
    platformCents: totalCents - processingCents,
    netCents: amt - totalCents,
    // True when the headline rate was too low to cover processing, i.e. the number the
    // earner sees is the floor rather than the percentage.
    isFloored: totalCents > nominalCents,
  };
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

/**
 * Net-of-fee value of a booking in DOLLARS, using that booking's OWN pinned rate.
 *
 * Goal trackers and tax estimates sum many bookings, and after a rate change or a
 * promotion those bookings do not share a rate — applying one global percentage to
 * all of them silently misreports what the earner actually took home. Falls back to
 * the founding rate for rows predating the pin.
 */
export function bookingNetDollars(grossDollars, feeBps) {
  const cents = Math.round((Number(grossDollars) || 0) * 100);
  return earnerNetCents(cents, feeBps) / 100;
}

/**
 * The rate to SHOW next to a computed fee, or null when no honest percentage exists.
 *
 * feeLabel(bps) renders the nominal rate and knows nothing about the processing floor
 * that platformFeeCents applies. Whenever the floor binds they contradict each other on
 * the same line: at 500 bps a $10 gig is charged 84c (8.4%) and a $25 gig 128c (5.12%),
 * both under a label reading "5%". The crossover at that rate is $26.19 — most of the
 * gig catalogue — so this is the common case, not an edge case.
 *
 * Returns null when the floor is what set the fee, because at that point the charge is
 * a MINIMUM rather than a percentage and any percentage printed beside it is wrong.
 * Callers render the label with no parenthetical, and the amount on the next line
 * carries the real information.
 */
export function effectiveFeeLabel(amountCents, feeBps = DEFAULT_FEE_BPS) {
  const amt = Number.isFinite(Number(amountCents)) ? Math.max(0, Math.trunc(Number(amountCents))) : 0;
  const bps = coerceBps(feeBps);
  if (amt <= 0) return feeLabel(bps);
  const nominal = Math.trunc((amt * bps + 5000) / 10000);
  return platformFeeCents(amt, bps) === nominal ? feeLabel(bps) : null;
}
