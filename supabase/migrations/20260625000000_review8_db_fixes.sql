-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 8 — database fixes. Applied via `supabase db push`.
--
--  #1 HIGH (regression): round-7 added `new.slot_id := old.slot_id` to both guard
--     branches AND a slot_id FK with ON DELETE SET NULL. They collide: deleting a
--     booked slot (every gig edit re-writes slots) fires the FK's internal
--     `UPDATE bookings SET slot_id = NULL`, which the guard reverts back to the old
--     non-null id, so the FK check fails and the whole edit aborts. Allow slot_id to
--     go NULL (the only legit non-self change) while still blocking a re-point to a
--     different/foreign slot.
--  #3 MEDIUM: the "core terms locked while a booking is active" rule was enforced
--     ONLY in the client — a poster could PATCH /jobs directly and change
--     pay/title/etc. mid-engagement (bait-and-switch). Add a guard_jobs_write
--     trigger that pins core columns server-side, mirroring the client lock.
--  #7 LOW: the guard let an earner set earner_done=true on a still-'pending'
--     (un-accepted) booking. Gate it to confirmed/completed.
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
    -- Allow slot_id to be NULLed (the FK's ON DELETE SET NULL cascade) but never
    -- re-pointed to a different/foreign slot.
    if new.slot_id is not null and new.slot_id is distinct from old.slot_id then
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
    if new.slot_id is not null and new.slot_id is distinct from old.slot_id then
      new.slot_id := old.slot_id;
    end if;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;
    new.amendment_note := old.amendment_note;
    new.tip_amount     := old.tip_amount;
    -- earner_done is only meaningful once the poster has accepted — block setting it
    -- on a still-pending (or declined/cancelled) booking.
    if new.earner_done is distinct from old.earner_done
       and old.status not in ('confirmed', 'completed') then
      new.earner_done := old.earner_done;
    end if;
    if new.status is distinct from old.status
       and not (new.status = 'completed' and old.poster_done)
       and not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
      new.status := old.status;
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- ── #3 — server-side core-term lock (mirrors the client amendment lock) ───────
create or replace function public.guard_jobs_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  has_active boolean;
  has_amend  boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select exists (
    select 1 from public.bookings b
    where b.job_id = old.id and b.status in ('confirmed', 'completed', 'verified')
  ) into has_active;

  if not has_active then
    return new;  -- no live booking → poster may edit freely
  end if;

  select exists (
    select 1 from public.bookings b
    where b.job_id = old.id and b.amendment_status = 'accepted'
  ) into has_amend;

  -- Pay is ALWAYS pinned while a booking is active — the escrow hold was authorized
  -- at the agreed amount and can't be re-priced in place (even under an amendment).
  new.pay      := old.pay;
  new.pay_type := old.pay_type;

  -- The remaining core terms unlock only when the earner accepted an amendment.
  if not has_amend then
    new.title       := old.title;
    new.category    := old.category;
    new.location    := old.location;
    new.lat         := old.lat;
    new.lng         := old.lng;
    new.description := old.description;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_jobs_write on public.jobs;
create trigger trg_guard_jobs_write
  before update on public.jobs
  for each row execute function public.guard_jobs_write();
