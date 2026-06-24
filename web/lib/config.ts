// Public configuration. These are publishable/anon keys — safe in client code
// (the mobile app ships the same values). Override via NEXT_PUBLIC_* env vars for
// a different environment without touching code.

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://nfioebqsgmmzhbksxozc.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu";

export const STRIPE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ??
  "pk_test_51ThvnVCx9mChh0x46xbXhjg4ejm3Ldwa0gLNMqky8eXFVjK60ZIUZwj6ujbIijxi6NdX99zyVr4gfEPg8iazMz9X00WtG1qQY8";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// Platform service fee — keep in sync with the stripe-create-payment-intent fn (10%).
export const SERVICE_FEE_PCT = 0.1;

// Marketing site URL (used for share links / metadata).
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gohustlr.com";
