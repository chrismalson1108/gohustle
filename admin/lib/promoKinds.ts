// promotions.kind has three values and only two of them have a consumer:
//
//   fee_override    → consume_promo_grant       (kind = 'fee_override')
//   poster_discount → consume_poster_discount   (kind = 'poster_discount')
//   bonus           → nobody. accrue_referral_bonus mints into bonus_ledger off the
//                     `referrals` table when the referred person's gig is verified, and
//                     never reads a grant.
//
// So a code or a direct grant on a bonus campaign produces a claim nothing can spend —
// and one the holder is stuck with, because promo_grants is unique per (user, promotion)
// and revoking does not free the slot. The database refuses both since migration
// 20260906031000; this list is what keeps the console from offering the operator a
// control that can only fail.
//
// It is a POSITIVE list on purpose. A fourth kind is inert on the day it is added,
// exactly as `bonus` was, so it stays out of these controls until a consumer learns it.
export const GRANTABLE_PROMO_KINDS = ["fee_override", "poster_discount"] as const;

export function isGrantableKind(kind: string | null | undefined): boolean {
  return !!kind && (GRANTABLE_PROMO_KINDS as readonly string[]).includes(kind);
}
