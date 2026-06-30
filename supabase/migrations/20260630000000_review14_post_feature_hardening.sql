-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 14 — harden the 2026-06-29 feature work (tags, hazards,
-- application notes, before-photos, certifications, market stats, availability,
-- job-start/cancel) that shipped AFTER the round 1-13 security pass.
--
-- All changes are additive + idempotent (create-or-replace / drop-if-exists), so
-- this file is safe to `supabase db push` and safe to re-run.
--
--   1. guard_bookings_write: pin the new counterparty-owned booking columns
--      (started_at, before_photos, application_note, cancellation_fee). Without
--      this a poster could stamp started_at to lock the earner out of cancelling,
--      blank the earner's before-photo proof, rewrite an applicant's note, or
--      forge a cancellation fee — none of which the round-6/13 guard pinned.
--   2. guard_jobs_write: allow ADDING hazards while a booking is active (more
--      safety disclosure is always fine) but block silently REMOVING one without
--      an accepted amendment — a worker relied on those hazards when committing.
--   3. profile_availability(uid): serve the opt-in availability through a
--      SECURITY DEFINER RPC that enforces (show_availability OR self) and REVOKE
--      the raw column grant, so a worker who opted out is no longer readable by
--      every authenticated user via a direct PostgREST query.
--   4. area_market_stats: add the missing >= 3 privacy threshold to worker_count.
--   5. CHECK constraints: cap application_note length and require certification
--      image_url to be an https URL (defuses a planted javascript:/data: link).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Booking write guard — pin the new counterparty-owned columns ───────────
-- Rebased on the round-13 definition (20260625040000_review13_verify_capture.sql);
-- the only additions are the new column pins, marked below.
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
    new.before_photos     := old.before_photos;      -- NEW: earner's proof, poster can't touch
    new.started_at        := old.started_at;         -- NEW: only the earner starts a job
    new.application_note  := old.application_note;    -- NEW: applicant's note is set once, at booking
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;
    -- NEW: cancellation_fee is recorded only on the poster's confirmed->cancelled action
    if not (old.status = 'confirmed' and new.status = 'cancelled') then
      new.cancellation_fee := old.cancellation_fee;
    end if;
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
    new.application_note := old.application_note;     -- NEW: set once at booking, never rewritten
    new.cancellation_fee := old.cancellation_fee;     -- NEW: earner never authors a cancellation fee
    -- NEW: started_at — allow ONLY the legitimate null->non-null transition while
    -- confirmed (the earner's "I'm on site"); block clearing, re-stamping, or
    -- setting it before the booking is confirmed.
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

-- ── 2. Jobs write guard — hazards add-only while a booking is active ───────────
-- Rebased on the round-8 definition (20260625000000_review8_db_fixes.sql); the
-- only addition is the hazards rule at the end.
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

  new.pay      := old.pay;
  new.pay_type := old.pay_type;

  if not has_amend then
    new.title       := old.title;
    new.category    := old.category;
    new.location    := old.location;
    new.lat         := old.lat;
    new.lng         := old.lng;
    new.description := old.description;
  end if;

  -- NEW: hazards may be ADDED (more disclosure is always safe) but never silently
  -- REMOVED without an accepted amendment. `old <@ new` means every existing hazard
  -- is still present; if not, a removal happened, so revert to the old set.
  if not has_amend
     and not (coalesce(old.hazards, '{}'::text[]) <@ coalesce(new.hazards, '{}'::text[])) then
    new.hazards := old.hazards;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_jobs_write on public.jobs;
create trigger trg_guard_jobs_write
  before update on public.jobs
  for each row execute function public.guard_jobs_write();

-- ── 3. Availability opt-out enforced server-side ──────────────────────────────
-- The raw column was granted to every authenticated user (20260629180000), so the
-- opt-out lived only in the client. Serve it through a gated RPC instead and revoke
-- the raw read. (show_availability — the boolean flag — stays granted; it isn't
-- sensitive and Settings needs it. The owner still reads their own availability via
-- my_profile(), and writes it via the unchanged UPDATE grant.)
create or replace function public.profile_availability(uid uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select p.availability
  from public.profiles p
  where p.id = uid
    and (p.show_availability or p.id = auth.uid());
$$;

revoke execute on function public.profile_availability(uuid) from public;
grant  execute on function public.profile_availability(uuid) to authenticated;

-- Stop exposing the raw weekly schedule to every signed-in user regardless of opt-in.
revoke select (availability) on public.profiles from authenticated;

-- ── 4. Market stats — privacy threshold on worker_count ───────────────────────
-- Rebased on 20260629170000_area_market_stats.sql; adds `having count(*) >= 3` to
-- the workers CTE so single-worker cities are suppressed (matching the tips CTE and
-- the function's stated ">= 3 so no single user can be inferred" guarantee).
create or replace function public.area_market_stats()
returns table (
  area         text,
  job_count    bigint,
  avg_pay      numeric,
  top_category text,
  avg_tip      numeric,
  worker_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with j as (
    select location as area, pay, category
    from public.jobs
    where status = 'open'
      and coalesce(location, '') <> ''
  ),
  agg as (
    select
      area,
      count(*)                                  as job_count,
      round(avg(pay), 2)                        as avg_pay,
      mode() within group (order by category)   as top_category
    from j
    group by area
  ),
  tips as (
    select jb.location as area, round(avg(b.tip_amount), 2) as avg_tip
    from public.bookings b
    join public.jobs jb on jb.id = b.job_id
    where b.tip_amount > 0
      and coalesce(jb.location, '') <> ''
    group by jb.location
    having count(*) >= 3
  ),
  workers as (
    select city as area, count(*) as worker_count
    from public.profiles
    where coalesce(city, '') <> ''
    group by city
    having count(*) >= 3            -- NEW: suppress single-worker cities
  )
  select
    a.area,
    a.job_count,
    a.avg_pay,
    a.top_category,
    t.avg_tip,
    w.worker_count
  from agg a
  left join tips t    on t.area = a.area
  left join workers w on w.area = a.area
  where a.job_count >= 3
  order by a.job_count desc;
$$;

grant execute on function public.area_market_stats() to anon, authenticated;

-- ── 5. Content/length CHECK constraints (server-side backstops) ───────────────
alter table public.bookings drop constraint if exists bookings_application_note_len;
alter table public.bookings add constraint bookings_application_note_len
  check (application_note is null or char_length(application_note) <= 500);

alter table public.certifications drop constraint if exists certifications_image_url_https;
alter table public.certifications add constraint certifications_image_url_https
  check (image_url is null or image_url ~ '^https://');
