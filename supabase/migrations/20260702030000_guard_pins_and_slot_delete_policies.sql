-- Launch-audit follow-ups (all tracked so a fresh rebuild reproduces them):
--   1. guard_jobs_write: also pin estimated_hours while a booking is active, so an
--      hourly gig's effective price (pay x estimated_hours) can't be re-priced mid-
--      engagement by editing the hours (pay/pay_type were already pinned).
--   2. guard_bookings_write: pin poster_rating/poster_review in the POSTER branch —
--      the EARNER authors those (their rating of the poster), so a poster must not be
--      able to overwrite the rating they supposedly received.
--   3. job_slots / job_requirements DELETE policies (owner-only): these previously
--      lived ONLY in the superseded migration_security_hardening_5.sql, so a rebuild
--      from schema.sql + tracked migrations would lack them and silently break gig
--      editing (edit = delete-then-reinsert sub-rows). Re-declare them here.
-- Both functions are recreated in full (create or replace) with only the additions.

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

  new.pay             := old.pay;
  new.pay_type        := old.pay_type;
  -- estimated_hours multiplies pay for hourly escrow, so it's part of the price and
  -- must be pinned like pay while a booking is live (re-pricing needs cancel+rebook).
  new.estimated_hours := old.estimated_hours;

  if not has_amend then
    new.title       := old.title;
    new.category    := old.category;
    new.location    := old.location;
    new.lat         := old.lat;
    new.lng         := old.lng;
    new.description := old.description;
  end if;

  if not has_amend
     and not (coalesce(old.hazards, '{}'::text[]) <@ coalesce(new.hazards, '{}'::text[])) then
    new.hazards := old.hazards;
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_jobs_write() from public;

-- Owner-only DELETE policies for gig sub-rows (moved out of the superseded file).
drop policy if exists "slots_delete_poster" on public.job_slots;
create policy "slots_delete_poster" on public.job_slots for delete using (
  exists (select 1 from public.jobs j where j.id = job_slots.job_id and j.poster_id = auth.uid())
);
drop policy if exists "reqs_delete_poster" on public.job_requirements;
create policy "reqs_delete_poster" on public.job_requirements for delete using (
  exists (select 1 from public.jobs j where j.id = job_requirements.job_id and j.poster_id = auth.uid())
);
