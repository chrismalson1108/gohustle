// ─────────────────────────────────────────────────────────────────────────────
// Redeeming a promo code, on the web. Mirrors src/lib/promoCodes.js.
//
// The mobile entry point landed first, which would have left a campaign distributed by
// code reaching phone users and not web users — the same one-surface gap that made 2FA
// bypassable by opening a browser.
//
// The RPC takes only a string and returns only true/false ON PURPOSE: distinct errors
// would be an existence oracle for brute-forcing valid codes, and it is rate-limited on
// ATTEMPTS rather than successes. So every failure gets ONE message here too.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "./supabaseClient";

/** Normalizes what people actually type: spaces, dashes, lowercase. */
export function normalizePromoCode(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
}

/** True only on a real claim. Every failure returns false with one message upstream. */
export async function redeemPromoCode(code: string): Promise<boolean> {
  const clean = normalizePromoCode(code);
  if (!clean) return false;
  const { data, error } = await supabase.rpc("redeem_promo_code", { p_code: clean });
  if (error) return false;
  return data === true;
}
