-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY: fix authorization-branch selection in guard_bookings_write (2026-07-22).
--
-- Two defects, both reachable with a single PostgREST PATCH by any user (every
-- user can post gigs, so every earner can obtain a job they own):
--
--   1. The authorizing poster was resolved from `coalesce(new.job_id, old.job_id)`
--      BEFORE branching. On UPDATE `new.job_id` is client-supplied, so an earner
--      could set job_id to a gig THEY posted and be routed into the POSTER branch
--      — which does not pin poster_done, earner_rating or review_text. That let an
--      earner force confirmed -> completed without the poster marking done (locking
--      the poster's escrow hold, since stripe-cancel-payment refuses to release a
--      completed booking) and forge the poster's rating/review of them.
--      job_id was restored inside the branch, so the stored row looked untouched.
--
--   2. If auth.uid() matched NEITHER the resolved poster nor old.earner_id, the
--      function fell through to a bare `return new` with ZERO pins. Pointing
--      job_id at a third party's gig reached this path and allowed arbitrary
--      writes to every column, including a permanently repointed job_id.
--
-- Fix: resolve the poster from OLD on UPDATE (NEW only on INSERT), and deny by
-- default instead of falling through unpinned. Every other pin is preserved
-- verbatim from 20260715000000_pin_booking_starts_at.sql.
--
-- Defence in depth: bookings_update_parties is USING-only, so its implied
-- WITH CHECK runs AFTER this BEFORE-trigger has already restored job_id. Add an
-- explicit WITH CHECK so a forged job_id/earner_id is rejected at the RLS layer.
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

  -- SECURITY: on UPDATE resolve the authorizing poster from the STORED row.
  -- coalesce(new.job_id, ...) trusted a client-supplied job_id, letting an earner
  -- point job_id at a gig they posted and be routed into the poster branch.
  select poster_id into poster from public.jobs
   where id = (case when tg_op = 'INSERT' then new.job_id else old.job_id end);

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

  -- SECURITY: deny by default. Previously this fell through as an UNPINNED
  -- `return new`, so a caller who matched neither branch could rewrite every
  -- column. Only the two parties may ever update a booking.
  raise exception 'not authorized to modify this booking';
end;
$$;
revoke execute on function public.guard_bookings_write() from public;


-- Explicit WITH CHECK: the post-image must still belong to the same two parties.
drop policy if exists "bookings_update_parties" on public.bookings;
create policy "bookings_update_parties" on public.bookings for update
using (
  auth.uid() = earner_id
  or exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
)
with check (
  auth.uid() = earner_id
  or exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
);
