import { supabase } from './supabase';
import { DEFAULT_FEE_BPS } from '../../shared/pricing';

export const STRIPE_PUBLISHABLE_KEY =
  'pk_test_51ThvnME0UZFlVCOpQlxjXv3XFqLV75mP9rcKG8bPTlwTLeRKxsmpZ3HwfOWWi9q9AgCa3VHDSw0inieexGl57iPB00I1A94JvY';

// DEPRECATED — prefer src/lib/pricing.js.
//
// The rate is no longer a constant: it lives in public.platform_rates and is PINNED
// per booking (bookings.fee_bps_quoted). This export survives only so older call
// sites keep compiling, and it resolves to the FOUNDING rate, not necessarily the
// current one. Anything quoting a new gig should call getFeeBps(); anything showing
// an existing booking should use that booking's pinned rate via bookingFeeBps().
export const SERVICE_FEE_PCT = DEFAULT_FEE_BPS / 10000;

const FUNCTIONS_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu';

// Stripe Connect/Identity flows open in a browser and redirect back to a hosted
// landing page on the web app (Supabase Edge Functions can't serve browser HTML —
// the gateway forces text/plain). Mobile has no web origin, so it passes this base.
// Canonical public domain (exempt from Vercel deployment protection once connected).
const WEB_RETURN_BASE = 'https://gohustlr.com';

async function callEdgeFunction(name, body = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'Edge function error');
    err.code = data.error;
    throw err;
  }
  return data;
}

export const stripeEdge = {
  createPaymentIntent: (bookingId) =>
    callEdgeFunction('stripe-create-payment-intent', { bookingId }),

  // Server-verified accept: confirms the booking ONLY if a real escrow hold exists.
  acceptBooking: (bookingId) =>
    callEdgeFunction('accept-booking', { bookingId }),

  capturePayment: (bookingId, pct, disputeReason) =>
    callEdgeFunction('stripe-capture-payment', { bookingId, pct, disputeReason }),

  // H3: earner claims settlement of their own completed work after the poster ghosts.
  claimEarnerPayment: (bookingId) =>
    callEdgeFunction('earner-claim-payment', { bookingId }),

  tip: (bookingId, tipCents) =>
    callEdgeFunction('stripe-tip', { bookingId, tipCents }),

  cancelPayment: (bookingId) =>
    callEdgeFunction('stripe-cancel-payment', { bookingId }),

  getPayoutOnboardingUrl: () =>
    callEdgeFunction('stripe-connect-onboard', { origin: WEB_RETURN_BASE }),

  // Live Connect status (retrieves the account from Stripe + syncs the cached flag);
  // does NOT depend on the account.updated webhook.
  getPayoutStatus: () =>
    callEdgeFunction('stripe-connect-status'),

  createSetupIntent: () =>
    callEdgeFunction('stripe-create-setup-intent'),

  getPaymentMethodStatus: () =>
    callEdgeFunction('stripe-payment-method-status'),

  getPayoutLoginLink: () =>
    callEdgeFunction('stripe-payout-login-link'),

  detachPaymentMethod: () =>
    callEdgeFunction('stripe-detach-payment-method'),

  createIdentitySession: () =>
    callEdgeFunction('stripe-create-identity-session', { origin: WEB_RETURN_BASE }),
};
