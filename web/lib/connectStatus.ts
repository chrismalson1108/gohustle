// Client mirror of the payout-readiness contract returned by the
// stripe-connect-status edge function. Source of truth:
// supabase/functions/_shared/connectStatus.ts — keep these in sync.
//
// WHY IT'S NOT A BOOLEAN: Stripe Express onboarding lets a user defer requirements
// ("Skip for now"), and real identity checks sit in review for hours. Those two look
// identical through a single `onboarded` flag but need opposite UI — "go finish it"
// vs "nothing to do, Stripe is checking". `state` is what the UI should branch on.

export type ConnectState =
  | "none" // no Connect account yet
  | "incomplete" // Stripe wants something FROM THE USER — send them back
  | "pending" // Stripe is reviewing; the user just waits
  | "restricted" // rejected / paused — support territory
  | "active"; // charges + payouts live

export interface ConnectStatus {
  hasAccount: boolean;
  /** Unchanged semantics — the server-side escrow gate reads exactly this. */
  onboarded: boolean;
  state: ConnectState;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** True only when the user must return to Stripe and supply something. */
  needsAction: boolean;
  /** True when Stripe is reviewing and the user should simply wait. */
  pendingVerification: boolean;
  /** Human-readable list of what Stripe still wants. */
  requirements: string[];
  disabledReason: string | null;
  /** Unix seconds — when Stripe will disable the account if requirements go unmet. */
  deadline: number | null;
  title: string;
  message: string;
}

/** Well-formed "no payout account" status — never hand a half-object to the UI. */
export const NO_PAYOUT_ACCOUNT: ConnectStatus = {
  hasAccount: false,
  onboarded: false,
  state: "none",
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  needsAction: true,
  pendingVerification: false,
  requirements: [],
  disabledReason: null,
  deadline: null,
  title: "Set up payouts",
  message: "Connect a bank account so you can get paid for the jobs you complete.",
};

/**
 * Offline/error fallback built from the cached `stripe_accounts.onboarded` flag.
 * The cache can only tell us "fully done" or "not fully done" — it cannot
 * distinguish incomplete from pending, so the copy stays deliberately vague
 * rather than guessing and telling the user something false.
 */
export function cachedPayoutStatus(hasAccount: boolean, onboarded: boolean): ConnectStatus {
  if (!hasAccount) return NO_PAYOUT_ACCOUNT;
  if (onboarded) {
    return {
      ...NO_PAYOUT_ACCOUNT,
      hasAccount: true,
      onboarded: true,
      state: "active",
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      needsAction: false,
      title: "Payouts are active",
      message: "Your bank is connected. Earnings deposit automatically after a job is verified.",
    };
  }
  return {
    ...NO_PAYOUT_ACCOUNT,
    hasAccount: true,
    state: "incomplete",
    detailsSubmitted: true,
    title: "Finish your payout setup",
    message: "Your payout account isn’t finished yet. Open payout setup to see what Stripe still needs.",
  };
}
