-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 13 — close the capture-side escrow bypass (HIGH).
--
-- Round 11 closed the AUTHORIZE side (a client can no longer flip pending->confirmed;
-- only the server-verified accept-booking edge fn can, after attesting a real hold).
-- But the symmetric CAPTURE side was left client-driven: guard_bookings_write let the
-- poster flip completed->verified unconditionally. Earner payout happens ONLY inside
-- stripe-capture-payment (capture + credit_earnings); a poster could PATCH
-- status='verified' directly via PostgREST, skipping capture entirely — the earner is
-- marked paid and rated, but the authorization hold is never captured (it expires and
-- refunds the poster). Free work, capture-side.
--
-- Fix: allow completed->verified ONLY when a CAPTURED payment exists for the booking.
-- Unlike 'authorized' (which stripe-create-payment-intent writes prematurely at PI
-- creation), 'captured' is set ONLY after a real Stripe capture that has already run
-- credit_earnings — so it honestly attests the earner was paid. The legit flow
-- (verifyAndRate calls capturePayment BEFORE writing status) satisfies this; a direct
-- PostgREST verify with no capture is reverted. A captured payment can't be obtained
-- without paying the earner, so a poster cannot verify without paying.
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
    -- Poster may NOT confirm directly (escrow hold attested only by accept-booking),
    -- and may verify ONLY once a CAPTURED payment exists (earner has been paid).
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
