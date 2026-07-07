-- ─────────────────────────────────────────────────────────────────────────────
-- Drop the superseded, non-idempotent credit_tip() RPC (2026-07-07).
--
-- Security audit finding (Info / hardening): public.credit_tip(uuid,uuid,integer)
-- (review6) was the pre-ledger tip-credit function. It was replaced by
-- claim_and_credit_tip(text,uuid,uuid,integer) (review7), which adds the tip_ledger
-- idempotency claim so a retry/replay can't double-credit. credit_tip() has NO
-- idempotency guard — each call unconditionally increments bookings.tip_amount and
-- profiles.earnings_* — so it is a latent double-credit foot-gun. It is NOT currently
-- exploitable (EXECUTE is revoked from public/anon/authenticated and no edge function
-- references it — stripe-tip uses claim_and_credit_tip), but dropping the dead
-- function removes the foot-gun from the attack surface entirely. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.credit_tip(uuid, uuid, integer);
