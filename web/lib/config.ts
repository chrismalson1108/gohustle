// Public configuration. These are publishable/anon keys — safe in client code
// (the mobile app ships the same values). Override via NEXT_PUBLIC_* env vars for
// a different environment without touching code.

import { DEFAULT_FEE_BPS } from "@gohustlr/shared";

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://nfioebqsgmmzhbksxozc.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu";

export const STRIPE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ??
  "pk_test_51ThvnME0UZFlVCOpQlxjXv3XFqLV75mP9rcKG8bPTlwTLeRKxsmpZ3HwfOWWi9q9AgCa3VHDSw0inieexGl57iPB00I1A94JvY";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// DEPRECATED — prefer @gohustlr/shared's platformFeeCents / earnerNetCents.
//
// The rate is no longer a constant: it lives in public.platform_rates and is PINNED
// per booking (bookings.fee_bps_quoted). This export survives only so older call
// sites keep compiling, and it resolves to the FOUNDING rate, not necessarily the
// current one.
export const SERVICE_FEE_PCT = DEFAULT_FEE_BPS / 10000;

// Marketing site URL (used for share links / metadata).
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gohustlr.com";
