import { supabase } from "./supabaseClient";
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "./config";

// Calls a Supabase Edge Function with the current user's bearer token.
// Mirror of src/lib/stripeClient.js `callEdgeFunction` — the backend is shared.
export async function callEdgeFunction<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || "Edge function error") as Error & {
      code?: string;
    };
    err.code = data.error;
    throw err;
  }
  return data as T;
}

// Thin wrappers over the existing Stripe edge functions (identical to mobile).
export const stripeEdge = {
  createPaymentIntent: (bookingId: string) =>
    callEdgeFunction<{
      clientSecret: string;
      amount?: number;
      amountCents?: number;
      savedCard?: { id: string; brand: string | null; last4: string | null } | null;
    }>(
      "stripe-create-payment-intent",
      { bookingId },
    ),
  // Server-verified accept: confirms the booking ONLY if a real escrow hold exists.
  acceptBooking: (bookingId: string) =>
    callEdgeFunction<{ ok: boolean }>("accept-booking", { bookingId }),
  capturePayment: (bookingId: string, pct?: number) =>
    callEdgeFunction("stripe-capture-payment", { bookingId, pct }),
  tip: (bookingId: string, tipCents: number) =>
    callEdgeFunction("stripe-tip", { bookingId, tipCents }),
  cancelPayment: (bookingId: string) =>
    callEdgeFunction("stripe-cancel-payment", { bookingId }),
  getPayoutOnboardingUrl: () =>
    callEdgeFunction<{ url: string }>("stripe-connect-onboard", {
      // Stripe returns the browser to <origin>/stripe/connect-return after onboarding.
      origin: typeof window !== "undefined" ? window.location.origin : undefined,
    }),
  // Live Connect status (retrieves the account from Stripe + syncs the cached flag) —
  // does NOT depend on the account.updated webhook, which for connected accounts may
  // never fire.
  getPayoutStatus: () =>
    callEdgeFunction<{ hasAccount: boolean; onboarded: boolean }>("stripe-connect-status"),
  // NOTE: the edge function returns the SetupIntent secret as `setupIntentClientSecret`
  // (see src/screens/PayoutSetupScreen.js + supabase/functions/stripe-create-setup-intent).
  createSetupIntent: () =>
    callEdgeFunction<{ setupIntentClientSecret: string; customerId?: string; ephemeralKey?: string }>(
      "stripe-create-setup-intent",
    ),
  getPaymentMethodStatus: () =>
    callEdgeFunction<{ hasPaymentMethod: boolean; brand?: string | null; last4?: string | null }>(
      "stripe-payment-method-status",
    ),
  getPayoutLoginLink: () => callEdgeFunction<{ url: string }>("stripe-payout-login-link"),
  detachPaymentMethod: (exceptPaymentMethodId?: string) =>
    callEdgeFunction<{ ok?: boolean }>("stripe-detach-payment-method", { exceptPaymentMethodId }),
  createIdentitySession: () =>
    callEdgeFunction<{ url?: string; client_secret?: string }>(
      "stripe-create-identity-session",
      // Stripe returns the browser to <origin>/stripe/identity-return when finished.
      { origin: typeof window !== "undefined" ? window.location.origin : undefined },
    ),
};
