// Client mirror of the payout-readiness contract returned by the
// stripe-connect-status edge function. Source of truth:
// supabase/functions/_shared/connectStatus.ts — keep these in sync.
// (Web has its own typed copy at web/lib/connectStatus.ts.)
//
// WHY IT'S NOT A BOOLEAN: Stripe Express onboarding lets a user defer requirements
// ("Skip for now"), and real identity checks sit in review for hours. Those two look
// identical through a single `onboarded` flag but need opposite UI — "go finish it"
// vs "nothing to do, Stripe is checking". Branch the UI on `state`.
//
// states: 'none' | 'incomplete' | 'pending' | 'restricted' | 'active'

/** Well-formed "no payout account" status — never hand a half-object to the UI. */
export const NO_PAYOUT_ACCOUNT = {
  hasAccount: false,
  onboarded: false,
  state: 'none',
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  needsAction: true,
  pendingVerification: false,
  requirements: [],
  disabledReason: null,
  deadline: null,
  title: 'Set up payouts',
  message: 'Connect a bank account so you can get paid for the jobs you complete.',
};

/**
 * Offline/error fallback built from the cached `stripe_accounts.onboarded` flag.
 * The cache can only say "fully done" or "not fully done" — it can't tell incomplete
 * from pending, so the copy stays deliberately vague rather than guessing and telling
 * the user something false.
 */
export function cachedPayoutStatus(hasAccount, onboarded) {
  if (!hasAccount) return NO_PAYOUT_ACCOUNT;
  if (onboarded) {
    return {
      ...NO_PAYOUT_ACCOUNT,
      hasAccount: true,
      onboarded: true,
      state: 'active',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      needsAction: false,
      title: 'Payouts are active',
      message: 'Your bank is connected. Earnings deposit automatically after a job is verified.',
    };
  }
  return {
    ...NO_PAYOUT_ACCOUNT,
    hasAccount: true,
    state: 'incomplete',
    detailsSubmitted: true,
    title: 'Finish your payout setup',
    message: "Your payout account isn't finished yet. Open payout setup to see what Stripe still needs.",
  };
}
