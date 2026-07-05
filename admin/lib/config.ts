// Public values only — the service-role key is read exclusively in
// lib/serviceClient.ts (a server-only module). Same publishable values as
// web/lib/config.ts.

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://nfioebqsgmmzhbksxozc.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu";

// Public user-facing app — password-reset links must land here (the admin app
// has no reset page). Matches the Supabase Auth redirect allow-list.
export const USER_APP_URL = process.env.NEXT_PUBLIC_USER_APP_URL ?? "https://gohustlr.com";

// Stripe dashboard deep-link base. TEST while in beta; at live cutover set
// NEXT_PUBLIC_STRIPE_DASHBOARD_BASE=https://dashboard.stripe.com in Vercel.
export const STRIPE_DASHBOARD_BASE =
  process.env.NEXT_PUBLIC_STRIPE_DASHBOARD_BASE ?? "https://dashboard.stripe.com/test";
