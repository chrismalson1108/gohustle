-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 4 (idempotent). Run in the Supabase SQL editor.
-- Referrals: block self-referral (a user crediting themselves as their own
-- referrer). The insert policy already pins referred_id to the caller; this also
-- requires the referrer to be a different person. Low impact (no automatic
-- reward is attached to a referral) but closes the audit's referral-integrity note.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "referrals_insert_self" on public.referrals;
create policy "referrals_insert_self" on public.referrals for insert
  with check (auth.uid() = referred_id and referrer_id <> referred_id);
