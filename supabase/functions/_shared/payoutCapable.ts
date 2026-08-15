// ─────────────────────────────────────────────────────────────────────────────
// "Can this earner actually be paid?" — asked of STRIPE, not of our cache.
//
// stripe_accounts.onboarded is a cached flag. Setting it false is always correct — only
// stripe-connect-status writes that, and only after a live retrieve says so. The problem
// is the flag going STALE at false afterwards: the account gets fixed at Stripe, nothing
// tells us, and both settle paths refuse.
//
// The two refusals are not symmetric with the one at authorization time.
// stripe-create-payment-intent has always re-verified live before blocking a booking
// (index.ts:113-125, the block this is lifted from) because blocking a booking is
// recoverable — the poster tries again later. Refusing to SETTLE is not: the work is done,
// the hold is live, and if nothing clears the flag the authorization voids at ~7 days
// leaving the worker unpaid AND the poster uncharged.
//
// The claim leg largely self-heals — EarnScreen calls getPayoutStatus() on mount, which is
// stripe-connect-status doing a live retrieve and syncing both ways, and the Claim button
// is on that same screen. The poster-initiated capture leg does not: the poster's app has
// no reason to refresh the EARNER's flag, and no client handles EARNER_PAYOUTS_DISABLED at
// all, so the poster just sees a generic failure.
//
// Detection exists but is slow: ctl_escrow_hold_expiring_work_done fires between days 5
// and 8, roughly two days before Stripe cancels. This closes the gap rather than relying
// on someone reading the board in time.
//
// Found by the 2026-08-12 payments audit, reproduced against current code 2026-08-14.
// ─────────────────────────────────────────────────────────────────────────────
import type Stripe from 'npm:stripe@22';
import { type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type PayoutCapability = {
  /** True only when Stripe says the account can take a transfer right now. */
  capable: boolean;
  /** Present when we could not ask Stripe at all — distinct from a definite "no". */
  unverifiable?: boolean;
  accountId?: string;
};

/**
 * Resolve payout capability for an earner, consulting Stripe when the cache says no.
 *
 * Deliberately asymmetric, mirroring the authorization-time block it is lifted from:
 *   · cache says YES  → believe it. A stale TRUE is caught downstream — the capture
 *     itself fails against a restricted destination, which is loud and immediate.
 *   · cache says NO   → ask Stripe, because a stale FALSE is silent and expensive.
 *
 * `unverifiable` is returned rather than folded into `capable` so the caller can decide.
 * At settle time refusing on an unreachable Stripe is the wrong default: the work is done
 * and the hold is live, so a transient API error should not start the clock on a voided
 * authorization.
 */
export async function payoutCapable(
  stripe: Stripe,
  supabase: SupabaseClient,
  earnerId: string,
): Promise<PayoutCapability> {
  const { data: acct } = await supabase
    .from('stripe_accounts')
    .select('account_id, onboarded')
    .eq('user_id', earnerId)
    .maybeSingle();

  const accountId = (acct as { account_id?: string } | null)?.account_id;
  if (!accountId) return { capable: false };
  if ((acct as { onboarded?: boolean } | null)?.onboarded) return { capable: true, accountId };

  try {
    const acc = await stripe.accounts.retrieve(accountId);
    const capable = !!(acc.details_submitted && acc.charges_enabled && acc.payouts_enabled);
    if (capable) {
      // Sync the cache so the next reader — and the controls — see the truth.
      await supabase.from('stripe_accounts').update({ onboarded: true }).eq('account_id', accountId);
    }
    return { capable, accountId };
  } catch (_) {
    // We do not know. Say so; do not report a definite refusal we cannot support.
    return { capable: false, unverifiable: true, accountId };
  }
}
