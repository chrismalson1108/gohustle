import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { STRIPE_PUBLISHABLE_KEY } from "./config";

// Singleton Stripe.js instance for Elements (poster card setup, escrow confirm).
let _stripe: Promise<Stripe | null> | null = null;

export function getStripe(): Promise<Stripe | null> {
  if (!_stripe) _stripe = loadStripe(STRIPE_PUBLISHABLE_KEY);
  return _stripe;
}
