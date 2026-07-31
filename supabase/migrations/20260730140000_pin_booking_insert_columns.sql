-- ─────────────────────────────────────────────────────────────────────────────
-- Pin the server-owned booking columns on INSERT too (2026-07-30).
--
-- guard_bookings_write's UPDATE branch pins started_at, tip_amount, the photo
-- arrays, cancellation_fee, poster_rating/review and amendment_* to old.* — it
-- treats all of them as server-owned. Its INSERT branch pins only status,
-- earner_done, poster_done, earner_rating and (correctly, server-derived)
-- starts_at. Everything else was whatever the client PUT in the row.
--
-- THE ONE THAT COSTS MONEY: bookings.started_at, the "I'm on site" stamp. Two
-- independent controls refuse to release a poster's escrow hold once it is set —
--
--   * trg_guard_started_booking_cancel (20260629190000:33) raises on
--     `new.status = 'cancelled' and old.started_at is not null`
--   * stripe-cancel-payment returns 409 "Work has already started; open a
--     dispute instead." (index.ts:48-51)
--
-- — and neither asks WHEN it was set. So: an earner books a gig with started_at
-- already stamped. The row is forced to 'pending', so nothing looks wrong. The
-- poster accepts, and the escrow hold goes on their card. From that moment the
-- poster can neither cancel the booking nor release the hold; the money sits
-- authorized until Stripe expires it ~7 days later, and the only remaining route
-- is a dispute, which is a terminal audit row with no adjudication (KNOWN_RISKS
-- 5.2). One earner-controlled column, written once, disarms the poster's only
-- way out.
--
-- The others are pinned in the same pass because they are the same class and have
-- no legitimate value on a booking that does not exist yet: work cannot have been
-- photographed, tipped, rated or amended before it was requested. Fields the
-- earner legitimately sets at INSERT — counter_offer, application_note, slot_id,
-- slot_label — are deliberately untouched.
--
-- Generated from 20260722000000 (the LATEST definition; 20260702030000 and
-- 20260715000000 are superseded) by scripted replacement and diffed: the pins are
-- added, nothing is removed, and both the self-booking check and the server-side
-- starts_at derivation are preserved verbatim. Existing rows are untouched — this
-- fires on write. Idempotent.
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
    -- A booking that is being created cannot already be under way, already
    -- photographed, already tipped, already rated or already amended. The UPDATE
    -- branch below pins every one of these to old.*, i.e. treats them as
    -- server-owned — but INSERT left them to whatever the client sent.
    --
    -- started_at is the one that costs money. Two separate controls refuse to
    -- release a poster's escrow hold once it is set: trg_guard_started_booking_cancel
    -- (20260629190000:33) blocks the row transition to 'cancelled', and
    -- stripe-cancel-payment returns 409 "Work has already started". So an earner
    -- who stamps it at INSERT is accepted as pending, the poster accepts and the
    -- hold is placed, and from then on the poster CANNOT cancel or release it —
    -- their card stays authorized until Stripe expires it, and the only route left
    -- is a dispute, which has no adjudication path (KNOWN_RISKS 5.2).
    new.started_at        := null;
    new.tip_amount        := 0;
    new.completion_photos := '{}';
    new.before_photos     := '{}';
    new.cancellation_fee  := null;
    new.poster_rating     := null;
    new.poster_review     := null;
    new.amendment_status  := 'none';
    new.amendment_note    := null;
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
