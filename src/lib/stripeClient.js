import { supabase } from './supabase';

export const STRIPE_PUBLISHABLE_KEY =
  'pk_test_51ThvnVCx9mChh0x46xbXhjg4ejm3Ldwa0gLNMqky8eXFVjK60ZIUZwj6ujbIijxi6NdX99zyVr4gfEPg8iazMz9X00WtG1qQY8';

const FUNCTIONS_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu';

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

  capturePayment: (bookingId) =>
    callEdgeFunction('stripe-capture-payment', { bookingId }),

  cancelPayment: (bookingId) =>
    callEdgeFunction('stripe-cancel-payment', { bookingId }),

  getPayoutOnboardingUrl: () =>
    callEdgeFunction('stripe-connect-onboard'),

  createSetupIntent: () =>
    callEdgeFunction('stripe-create-setup-intent'),

  getPaymentMethodStatus: () =>
    callEdgeFunction('stripe-payment-method-status'),

  getPayoutLoginLink: () =>
    callEdgeFunction('stripe-payout-login-link'),

  detachPaymentMethod: () =>
    callEdgeFunction('stripe-detach-payment-method'),
};
