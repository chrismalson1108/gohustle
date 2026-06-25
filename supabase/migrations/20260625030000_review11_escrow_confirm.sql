-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 11 — close the escrow-at-confirm bypass (HIGH).
--
-- Round 10 required a payments row in ('authorized','captured') for pending->confirmed.
-- But stripe-create-payment-intent writes that row as 'authorized' at PI CREATION,
-- before the card is actually confirmed — so the check was hollow: a poster could
-- create the intent, never confirm the card, and PATCH the booking to 'confirmed',
-- getting free work. The fix makes the confirm path server-verified:
--   • The guard no longer lets a CLIENT flip pending->confirmed at all (only
--     'declined'/'cancelled' remain client-driven). The escrow-exists revert is
--     removed (superseded).
--   • The ONLY way to confirm is the new `accept-booking` edge function (service
--     role, exempt from this guard), which re-fetches the PaymentIntent from Stripe
--     and requires status 'requires_capture' — a REAL authorization hold — before
--     setting the booking 'confirmed'. A direct PostgREST confirm is now reverted.
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
    return new;
  end if;

  if auth.uid() = poster then
    new.earner_id         := old.earner_id;
    new.job_id            := old.job_id;
    if new.slot_id is distinct from old.slot_id and not (
      new.slot_id is null and old.slot_id is not null
      and not exists (select 1 from public.job_slots s where s.id = old.slot_id)
    ) then
      new.slot_id := old.slot_id;
    end if;
    new.earner_done       := old.earner_done;
    new.completion_photos := old.completion_photos;
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;
    if new.amendment_status is distinct from old.amendment_status
       and new.amendment_status not in ('pending', 'none') then
      new.amendment_status := old.amendment_status;
    end if;
    -- Poster may NOT confirm directly — confirming requires a verified escrow hold,
    -- which only the service-role accept-booking edge function can attest. The
    -- client-driven poster transitions are decline/cancel and the completion/verify
    -- steps; pending->confirmed is intentionally excluded here.
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('declined','cancelled'))
      or (old.status = 'confirmed' and new.status = 'cancelled')
      or (old.status = 'confirmed' and new.status = 'completed' and new.earner_done and new.poster_done)
      or (old.status = 'completed' and new.status = 'verified')
    ) then
      new.status := old.status;
    end if;
    return new;
  end if;

  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;
    new.earner_id      := old.earner_id;
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
