-- ─────────────────────────────────────────────────────────────────────────────
-- CRITICAL: pin bookings.starts_at in guard_bookings_write (2026-07-15).
--
-- earner-claim-payment's only ghosting time-gate anchors on booking.starts_at
-- (eligibleAt = starts_at + 3d grace). That column was NEVER pinned by
-- guard_bookings_write in either branch, and RLS bookings_update_parties has no
-- WITH CHECK, so an earner could PATCH starts_at to the past (or forge it at INSERT)
-- and self-capture the poster's full escrow hold for a future gig never performed.
-- The symmetric hole let a poster push starts_at forward to grief a legitimate
-- ghosting claim.
--
-- Fix: starts_at is authoritatively the scheduled time of the booked slot and must
-- ONLY ever be set on INSERT from job_slots. This recreates the authoritative guard
-- (faithful copy of 20260702030000_guard_pins_and_slot_delete_policies.sql) adding:
--   * INSERT branch: derive new.starts_at from the referenced job_slots row (poster-
--     owned), never trusting the client; no slot => null (no auto-settle window).
--   * BOTH update branches: new.starts_at := old.starts_at (hard pin).
-- Every other pin/behavior is preserved verbatim. Service role bypasses.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_bookings_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  poster uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select poster_id into poster from public.jobs where id = coalesce(new.job_id, old.job_id);

  if tg_op = 'INSERT' then
    new.status      := 'pending';
    new.earner_done := false;
    new.poster_done := false;
    new.earner_rating := null;
    if new.earner_id = poster then
      raise exception 'You cannot book your own gig';
    end if;
    if new.slot_id is not null and not exists (
      select 1 from public.job_slots s where s.id = new.slot_id and s.job_id = new.job_id
    ) then
      raise exception 'slot does not belong to this job';
    end if;
    -- starts_at is the poster-owned scheduled time of the booked slot — derive it
    -- server-side so the earner can't forge a past date to trip the ghosting gate.
    -- No slot => no authoritative scheduled time => null (auto-settle stays closed).
    if new.slot_id is not null then
      select s.starts_at into new.starts_at from public.job_slots s where s.id = new.slot_id;
    else
      new.starts_at := null;
    end if;
    return new;
  end if;

  if auth.uid() = poster then
    new.earner_id         := old.earner_id;
    new.job_id            := old.job_id;
    new.starts_at         := old.starts_at;  -- set only on INSERT from the slot
    if new.slot_id is distinct from old.slot_id and not (
      new.slot_id is null and old.slot_id is not null
      and not exists (select 1 from public.job_slots s where s.id = old.slot_id)
    ) then
      new.slot_id := old.slot_id;
    end if;
    new.earner_done       := old.earner_done;
    new.completion_photos := old.completion_photos;
    new.before_photos     := old.before_photos;
    new.started_at        := old.started_at;
    new.application_note  := old.application_note;
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;
    -- The earner authors their rating/review OF THE POSTER — the poster can't forge it.
    new.poster_rating     := old.poster_rating;
    new.poster_review     := old.poster_review;
    if not (old.status = 'confirmed' and new.status = 'cancelled') then
      new.cancellation_fee := old.cancellation_fee;
    end if;
    if new.amendment_status is distinct from old.amendment_status
       and new.amendment_status not in ('pending', 'none') then
      new.amendment_status := old.amendment_status;
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('declined','cancelled'))
      or (old.status = 'confirmed' and new.status = 'cancelled')
      or (old.status = 'confirmed' and new.status = 'completed' and new.earner_done and new.poster_done)
      or (old.status = 'completed' and new.status = 'verified'
          and exists (select 1 from public.payments p
                      where p.booking_id = old.id and p.status = 'captured'))
    ) then
      new.status := old.status;
    end if;
    return new;
  end if;

  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;
    new.earner_id      := old.earner_id;
    new.starts_at      := old.starts_at;  -- set only on INSERT from the slot
    if new.slot_id is distinct from old.slot_id and not (
      new.slot_id is null and old.slot_id is not null
      and not exists (select 1 from public.job_slots s where s.id = old.slot_id)
    ) then
      new.slot_id := old.slot_id;
    end if;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;
    new.amendment_note := old.amendment_note;
    new.tip_amount     := old.tip_amount;
    new.application_note := old.application_note;
    new.cancellation_fee := old.cancellation_fee;
    if old.started_at is not null or old.status <> 'confirmed' then
      new.started_at := old.started_at;
    end if;
    if new.earner_done is distinct from old.earner_done
       and old.status not in ('confirmed', 'completed') then
      new.earner_done := old.earner_done;
    end if;
    if new.status is distinct from old.status
       and not (new.status = 'completed' and old.status = 'confirmed' and old.poster_done)
       and not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
      new.status := old.status;
    end if;
    return new;
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_bookings_write() from public;
