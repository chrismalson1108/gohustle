-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (CRITICAL, money): stop a poster from unilaterally destroying the
-- earner's settlement path (2026-07-26).
--
-- H3 (earner-claim-payment) is the safety net for a ghosting poster: if the work
-- was done and the poster never verifies, the earner can claim settlement
-- themselves once the slot time is > EARNER_CLAIM_GRACE_DAYS (3) in the past.
-- That whole net hangs off two things the POSTER controls — the job_slots row it
-- reads the scheduled time from, and the absence of a disputes row — and nothing
-- stopped the poster from removing either. Three separate one-request kills, each
-- ending with the earner unpaid for work already performed:
--
--   1. DELETE the slot.  slots_delete_poster (20260702030000:177) allows deleting
--      ANY slot on a job you own, with no check for live bookings. bookings.slot_id
--      is `on delete set null` (20260624240000:105), so the booking survives with
--      slot_id = NULL and earner-claim-payment hits its `if (!booking.slot_id)`
--      branch and returns NO_SCHEDULE — permanently. ("Contact support to settle"
--      is the only remaining route, and the hold expires in ~7 days.)
--
--   2. UPDATE the slot's starts_at into the future.  slots_update_poster
--      (20260715110000) correctly pins OWNERSHIP on both sides of the update but
--      constrains no columns, so the poster can PATCH starts_at to next year. The
--      claim gate is `now >= slot.starts_at + 3 days`, so it returns TOO_EARLY
--      forever. Deliberately chosen by the function over bookings.starts_at
--      because the earner could edit that one — but the poster-owned column it
--      trusts instead was left just as mutable.
--
--   3. INSERT a disputes row.  disputes_insert_party (migration_location_tips_
--      disputes.sql:31) lets EITHER party insert, and earner-claim-payment blocks
--      on `disputeCount > 0` with no adjudication path to clear it
--      (KNOWN_RISKS §5.2: "disputes are a terminal audit row"). One INSERT is a
--      permanent, irreversible block on the payout.
--
-- Fixes, in the same order:
--
--   1+2. guard_job_slot_settlement_anchor — BEFORE UPDATE OR DELETE on job_slots.
--        A slot with a LIVE booking (pending/confirmed/completed) may not be
--        deleted, and its starts_at may not be moved. Everything else about the
--        slot stays editable, and a slot with no live booking is untouched, so
--        ordinary gig editing is unaffected.
--
--   3.   Drop the client INSERT policy on disputes entirely. Verified no client
--        writes disputes: the only inserts are server-side in
--        stripe-capture-payment (which records the poster's partial-capture reason
--        and says so: "the client no longer inserts this") and stripe-webhook
--        (chargeback/refund). Both run as service_role and bypass RLS, so removing
--        the policy changes no legitimate behaviour — it only removes the ability
--        to forge a permanent payout block from a PostgREST call.
--
-- Service role early-returns, matching every other guard_* function, so admin and
-- edge-function paths are unaffected. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_job_slot_settlement_anchor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_booking_count int;
  target_slot uuid;
begin
  -- Admin/edge paths bypass, same idiom as guard_bookings_write.
  if coalesce(auth.role(), '') = 'service_role' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  target_slot := old.id;

  select count(*) into live_booking_count
  from public.bookings b
  where b.slot_id = target_slot
    and b.status in ('pending', 'confirmed', 'completed');

  if live_booking_count = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'Cannot delete a time slot that has an active booking. Cancel the booking first.'
      using errcode = 'check_violation';
  end if;

  -- UPDATE: the scheduled time is the anchor earner-claim-payment settles against,
  -- so it is pinned while a booking is live. Other columns stay editable.
  if new.starts_at is distinct from old.starts_at then
    raise exception
      'Cannot change the time of a slot that has an active booking. Propose an amendment instead.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_job_slot_settlement_anchor() from public, anon, authenticated;

drop trigger if exists trg_guard_job_slot_settlement_anchor on public.job_slots;
create trigger trg_guard_job_slot_settlement_anchor
  before update or delete on public.job_slots
  for each row execute function public.guard_job_slot_settlement_anchor();

-- 3. Disputes are server-authored only. No client inserts them (verified across
--    src/, web/ and admin/); stripe-capture-payment and stripe-webhook do, as
--    service_role, bypassing RLS. Dropping this policy removes a forgeable,
--    permanent block on the earner's ghosting payout and changes nothing else.
drop policy if exists "disputes_insert_party" on public.disputes;

-- Verify post-deploy:
--   -- as the poster, with a confirmed booking on slot S:
--   DELETE /rest/v1/job_slots?id=eq.S                    -> 400 check_violation
--   PATCH  /rest/v1/job_slots?id=eq.S {"starts_at":...}  -> 400 check_violation
--   PATCH  /rest/v1/job_slots?id=eq.S {"label":"..."}    -> 200 (still editable)
--   POST   /rest/v1/disputes {...}                       -> 401/403 (no policy)
--   -- and a slot with no live booking must still delete cleanly.
