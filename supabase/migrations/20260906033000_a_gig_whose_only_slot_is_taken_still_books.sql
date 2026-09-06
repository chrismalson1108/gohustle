-- ─────────────────────────────────────────────────────────────────────────────
-- "Book this gig" on a gig whose only slot is already taken inserts a booking with
-- slot_id = NULL, and the database accepts it.
--
-- Every gig carries at least one slot: PostJob and EditJob attach a
-- "Flexible — Contact to Schedule" slot when the poster picks no times, precisely so a
-- listing can never be un-bookable. That slot is UNDATED (starts_at null) by design.
--
-- JobDetailScreen.handleBook refused a booking in two cases and neither one covered
-- this shape (src/screens/JobDetailScreen.js, before this change):
--
--     if (hasScheduledSlots && selectableSlots.length === 0) …refuse
--     if (!selectedSlot && selectableSlots.length > 0)       …refuse
--
-- A gig whose ONLY slot is the flexible one, already taken by an accepted earner, has
-- hasScheduledSlots = false (nothing carries a startsAt) and selectableSlots = []
-- (the one slot is taken). So the first guard is skipped for want of a dated slot and
-- the second for want of a selectable one, execution falls through, and the footer
-- even labels the button "Book this gig" in exactly this state.
--
-- ── NOTHING SERVER-SIDE STOPPED IT ──────────────────────────────────────────
--   * bookings_insert_own (schema.sql:153) checks only `auth.uid() = earner_id`.
--   * guard_bookings_write's INSERT branch (20260730140000) validates slot ownership
--     only `if new.slot_id is not null`, and sets starts_at := null otherwise.
--   * bookings_one_active_per_slot (20260624220000:95) is scoped
--     `where slot_id is not null`, so a null-slot booking is outside the one index
--     that stops a slot being sold twice.
--   * guard_booking_slot_not_past (20260813060000) returns early on a null slot_id.
--
-- ── WHAT THE ROW THEN COSTS ─────────────────────────────────────────────────
-- If the poster accepts it, a SECOND escrow hold goes on their card for a single-slot
-- gig that is already spoken for. The booking has no slot_id and therefore no
-- starts_at, so earner-claim-payment refuses it permanently with NO_SCHEDULE
-- (index.ts:82-89) — the earner's only self-service payout path when a poster ghosts
-- is closed for the life of the row — and ctl_live_booking_without_schedule_anchor
-- reports it as reason 'no_slot_id' from the moment it is accepted (that control is
-- scoped to confirmed/completed by 20260812100000, so an open application is invisible
-- to it). Detection already existed, one step too late; prevention did not exist at all.
--
-- Reachable even though Browse hides the gig (isJobBookable is slot-aware): the
-- poster's public profile lists their `status = 'open'` gigs with no slot check
-- (src/screens/PublicProfileScreen.js:143-144) and Saved gigs keeps closed gigs in a
-- muted group on purpose — both navigate straight to JobDetail.
--
-- ── WHY THE RULE LIVES HERE ─────────────────────────────────────────────────
-- The identical defect was found and fixed on the WEB client in f91ab4f (2026-07-26),
-- and the assistant's book_gig has always got it right (it leaves `slot` undefined
-- only when the gig has no slots at all). Mobile was the one surface still wrong. A
-- rule enforced in two clients out of three is not enforced — so it goes in the
-- database, where every client, the assistant and anything written later inherits it.
--
-- A gig with NO job_slots row at all is deliberately still bookable: that is anomalous
-- legacy data (PostJob has always attached the flexible slot), isJobBookable fails open
-- on it for the same reason, and refusing would break bookings that work today. This
-- guard says only: if a gig HAS slots, it is booked THROUGH one of them.
--
-- WHICH slot wins under contention is not decided here — bookings_one_active_per_slot
-- decides that atomically, and a read-then-decide "is it taken?" check in a trigger
-- would be a race pretending to be a guard. This closes the hole the index cannot see:
-- the row with no slot at all.
--
-- No service_role exemption, on purpose: nothing anywhere inserts a booking as the
-- service role (grep of supabase/functions and admin/ finds no booking insert), so an
-- exemption would only be a way in.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_booking_requires_slot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Booked through a slot: guard_bookings_write already proves the slot belongs to
  -- this job, guard_booking_slot_not_past proves it has not passed, and
  -- bookings_one_active_per_slot proves nobody else holds it.
  if new.slot_id is not null then
    return new;
  end if;

  -- No slot chosen. That is only legitimate on a listing that genuinely has none.
  if exists (select 1 from public.job_slots s where s.job_id = new.job_id) then
    raise exception 'This gig is booked through its time slots — pick an available one.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_booking_requires_slot() from public, anon, authenticated;

drop trigger if exists trg_a_guard_booking_requires_slot on public.bookings;
create trigger trg_a_guard_booking_requires_slot
  before insert on public.bookings
  for each row execute function public.guard_booking_requires_slot();


-- ── Prove it discriminates on the same staged row ───────────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; sid uuid; bid uuid;
  refused boolean;
  n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into poster from public.profiles where deleted_at is null limit 1;
  select id into earner from public.profiles where deleted_at is null and id <> poster limit 1;
  if poster is null then raise exception 'no live profile to stage against'; end if;
  if earner is null then earner := poster; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (poster, 'requires-slot probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- THE REPORTED SHAPE: one slot, undated ("Flexible"), already taken.
  insert into public.job_slots (job_id, label, taken)
  values (jid, 'Flexible — Contact to Schedule', true)
  returning id into sid;

  -- 1. The booking the old code produced: no slot_id, on a gig that has a slot.
  refused := false;
  begin
    insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'pending');
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'FIX FAILED: a slot-less booking was accepted on a gig that has slots';
  end if;
  raise notice 'a slot-less booking on a slotted gig is refused — the reported bug is closed';

  -- 2. THE DISCRIMINATION: without the trigger the very same insert succeeds, and
  --    lands in exactly the dead end the header describes.
  drop trigger trg_a_guard_booking_requires_slot on public.bookings;
  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'confirmed')
  returning id into bid;
  raise notice 'discriminates: with the trigger dropped the identical row inserts fine — that row is the defect';

  if bid is null or (select slot_id from public.bookings where id = bid) is not null then
    raise exception 'staging wrong: the probe booking did not end up slot-less';
  end if;

  -- And it is unsettleable, which is why this was detectable but not preventable.
  --
  -- Staged as CONFIRMED deliberately. ctl_live_booking_without_schedule_anchor is
  -- scoped `status in ('confirmed','completed')` — 20260812100000 narrowed it there on
  -- purpose, because a pending or declined booking has nothing left to settle. So the
  -- control cannot see this row while the application is merely open; it sees it the
  -- moment the poster accepts, which is the same moment the second escrow hold lands
  -- on their card. That is exactly the harm this trigger prevents, and staging the row
  -- as 'pending' here asserted something the control was never meant to do.
  select count(*) into n
    from public.ctl_live_booking_without_schedule_anchor() where entity_id = bid::text;
  if n <> 1 then
    raise exception 'expected ctl_live_booking_without_schedule_anchor to report the accepted phantom booking, got % rows', n;
  end if;
  raise notice 'once accepted, the phantom booking is reported as no_slot_id — detection without prevention is what this fixes';

  delete from public.bookings where id = bid;
  create trigger trg_a_guard_booking_requires_slot
    before insert on public.bookings
    for each row execute function public.guard_booking_requires_slot();

  -- 3. A REAL booking through a free slot is untouched.
  update public.job_slots set taken = false where id = sid;
  insert into public.bookings (job_id, earner_id, slot_id, slot_label, status)
  values (jid, earner, sid, 'Flexible — Contact to Schedule', 'pending')
  returning id into bid;
  if bid is null then
    raise exception 'REGRESSION: a normal booking through a free slot was refused';
  end if;
  raise notice 'a normal booking through a free slot still works';

  -- 4. A legacy gig with NO slots at all is deliberately still bookable.
  delete from public.bookings where job_id = jid;
  delete from public.job_slots where job_id = jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'pending')
  returning id into bid;
  if bid is null then
    raise exception 'REGRESSION: a gig with no slots at all became un-bookable';
  end if;
  raise notice 'a gig with no job_slots row is still bookable — the guard fails open exactly where isJobBookable does';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'requires-slot probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
