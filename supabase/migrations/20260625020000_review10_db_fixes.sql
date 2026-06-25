-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 10 — database fixes. Applied via `supabase db push`.
--
--  #1 HIGH (regression): guard_jobs_delete (round 9) only bypassed auth.role()=
--     'service_role'. The GDPR account-deletion cascade runs via GoTrue's admin
--     connection (role supabase_auth_admin, NO request JWT) where auth.role() is
--     NULL — so the guard RAISED and aborted auth.admin.deleteUser, breaking the
--     mandatory in-app account-deletion flow for any poster with an active booking.
--     Bypass the guard whenever there's no end-user JWT (the privileged cascade),
--     while still blocking a genuine end-user PostgREST hard-delete.
--  #2 MEDIUM: the poster branch allowed pending->confirmed on identity alone, with
--     no check that escrow was actually funded — a poster could PATCH status to
--     'confirmed' via PostgREST with no card hold, and the earner would work for
--     free. Require an authorized/captured payment to exist; otherwise REVERT the
--     status (revert, not raise — a raise here would risk the same flow-break as #1).
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
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('confirmed','declined','cancelled'))
      or (old.status = 'confirmed' and new.status = 'cancelled')
      or (old.status = 'confirmed' and new.status = 'completed' and new.earner_done and new.poster_done)
      or (old.status = 'completed' and new.status = 'verified')
    ) then
      new.status := old.status;
    end if;
    -- Escrow invariant: a booking may only become 'confirmed' once an escrow hold is
    -- authorized for it (the accept flow creates the payment BEFORE flipping status).
    -- Without it, revert — stops a direct PostgREST confirm with no funds held.
    if new.status = 'confirmed' and old.status = 'pending'
       and not exists (
         select 1 from public.payments p
         where p.booking_id = old.id and p.status in ('authorized', 'captured')
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

-- ── #1 — let the privileged (no-JWT) cascade through, still guard end users ───
create or replace function public.guard_jobs_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Bypass for service_role AND for any connection without an end-user JWT (the
  -- GoTrue admin cascade from auth.admin.deleteUser runs as supabase_auth_admin with
  -- no request.jwt.claims). Only genuine end-user (authenticated/anon) PostgREST
  -- deletes are guarded.
  if coalesce(auth.role(), '') = 'service_role'
     or current_setting('request.jwt.claims', true) is null then
    return old;
  end if;
  if exists (
    select 1 from public.bookings b
    where b.job_id = old.id and b.status in ('confirmed', 'completed', 'verified')
  ) then
    raise exception 'Cannot delete a job with an active booking — cancel or finish it first';
  end if;
  return old;
end;
$$;
