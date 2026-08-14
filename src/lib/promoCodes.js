// ─────────────────────────────────────────────────────────────────────────────
// Redeeming a promo code.
//
// `redeem_promo_code(text)` has existed and been granted to `authenticated` since the
// promotions system shipped, and had ZERO callers in any client. So the admin console
// could mint codes and no user could ever type one: a fee_override or poster_discount
// campaign distributed by code reached nobody. Direct grants (console → /pricing →
// grantToUsers) worked, so incentives were not blocked — but a minted code was a dead
// string, which is worse than not offering codes at all.
//
// ── WHY THE RPC TAKES ONLY A STRING AND RETURNS ONLY A BOOLEAN ──────────────
//
// Deliberate, and worth not "improving". Distinct errors — "no such code" vs "already
// used" vs "expired" — would make this an existence oracle for brute-forcing valid
// codes. It is also rate-limited server-side off promo_redeem_attempts, counting
// ATTEMPTS rather than successes, so a sweep that only ever fails still registers.
//
// The UI therefore says one thing for every failure. That is not laziness; it is the
// only shape that does not leak.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';

/** Normalizes what people actually type: spaces, dashes, lowercase. */
export function normalizePromoCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

/**
 * Claim a code for the signed-in user.
 * Returns true only on a real claim. Every failure — unknown, spent, expired,
 * already-held, rate-limited — returns false with the same message upstream.
 */
export async function redeemPromoCode(code) {
  const clean = normalizePromoCode(code);
  if (!clean) return false;
  const { data, error } = await supabase.rpc('redeem_promo_code', { p_code: clean });
  if (error) return false;
  return data === true;
}
