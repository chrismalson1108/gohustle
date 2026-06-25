-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 9 — database fixes. Applied via `supabase db push`.
--
--  #1 MEDIUM (regression): round-8 relaxed the slot_id pin to allow NULL (so the
--     FK's ON DELETE SET NULL cascade could run). But that also let a CLIENT set
--     slot_id=NULL on a live booking — freeing the slot (sync_slot_taken) and
--     reopening it for a double-booking. Allow NULL ONLY when it's the cascade
--     (the old slot row no longer exists); revert any client-driven slot change.
--  #2 MEDIUM: a poster could hard-DELETE a job that has an active booking +
--     authorized escrow, cascading away the bookings/payments rows. Block it.
--  #3 MEDIUM: the earner branch let a terminal 'verified' (paid-out) booking be
--     regressed back to 'completed' (the completed-transition check didn't pin
--     old.status). Gate it to confirmed -> completed only.
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
    -- slot_id may change ONLY via the FK's ON DELETE SET NULL cascade, which fires
    -- after the slot row is gone. Any client-driven change (NULLing a live slot, or
    -- re-pointing) is reverted — a client must not free/move a booked slot directly.
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
    -- Only confirmed -> completed (both done) or pending/confirmed -> cancelled.
    -- Pinning old.status='confirmed' on the completed path stops an earner regressing
    -- a terminal 'verified' (already paid-out) booking back to 'completed'.
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

-- ── #2 — block hard-deleting a job that has an active booking ─────────────────
create or replace function public.guard_jobs_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
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

drop trigger if exists trg_guard_jobs_delete on public.jobs;
create trigger trg_guard_jobs_delete
  before delete on public.jobs
  for each row execute function public.guard_jobs_delete();
