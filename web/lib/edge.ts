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
    callEdgeFunction<{ clientSecret: string; amount: number }>(
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
    callEdgeFunction<{ url: string }>("stripe-connect-onboard"),
  createSetupIntent: () =>
    callEdgeFunction<{ clientSecret: string }>("stripe-create-setup-intent"),
  getPaymentMethodStatus: () =>
    callEdgeFunction<{ hasPaymentMethod: boolean }>("stripe-payment-method-status"),
  getPayoutLoginLink: () => callEdgeFunction<{ url: string }>("stripe-payout-login-link"),
  detachPaymentMethod: () => callEdgeFunction("stripe-detach-payment-method"),
  createIdentitySession: () =>
    callEdgeFunction<{ url?: string; client_secret?: string }>(
      "stripe-create-identity-session",
    ),
};
