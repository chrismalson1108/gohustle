-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM, consent): one earner's amendment unlocked core-term edits for
-- EVERY earner on the gig (2026-07-26).
--
-- guard_jobs_write pins a live gig's core terms (title, category, location, lat, lng)
-- and lifts that pin once an amendment is accepted. The check was job-wide:
--
--     select exists (
--       select 1 from public.bookings b
--       where b.job_id = old.id and b.amendment_status = 'accepted'
--     ) into has_amend;
--
-- On a multi-slot gig with several earners, ONE of them accepting an amendment
-- unlocked the terms for ALL of them. The poster could then change the address, and
-- every other earner's agreed terms were rewritten underneath them without being
-- asked. Someone who accepted a job at one address could arrive to find the listing
-- had said somewhere else since. The amendment flow exists to capture per-booking
-- consent; the guard applied it per-job.
--
-- Fix: require unanimity among the parties actually affected — no live booking may
-- lack an accepted amendment. Single-booking gigs, the common case, are unchanged.
--
-- Generated from 20260715100000 so the rest of the function (the bump cooldown, every
-- pinned column) is byte-identical; only the has_amend predicate changes.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- Bump cooldown: a poster may refresh bumped_at at most once per 24h. If the value is
  -- being changed while the previous bump is under 24h old, silently revert to the old
  -- timestamp so the write succeeds but the bump is a no-op.
  if new.bumped_at is distinct from old.bumped_at
     and old.bumped_at is not null
     and old.bumped_at > now() - interval '24 hours' then
    new.bumped_at := old.bumped_at;
  end if;

  select exists (
    select 1 from public.bookings b
    where b.job_id = old.id and b.status in ('confirmed', 'completed', 'verified')
  ) into has_active;

  if not has_active then
    return new;  -- no live booking → poster may edit freely
  end if;

  -- Unlock core terms only when EVERY live booking on this gig has an accepted
  -- amendment — not merely one of them.
  --
  -- This was `exists (... amendment_status = 'accepted')`, i.e. job-wide: on a
  -- multi-slot gig, ONE earner accepting an amendment unlocked title, category and
  -- crucially LOCATION/lat/lng for the whole job, silently rewriting the agreed terms
  -- of every other earner's booking. Someone who agreed to a gig at one address could
  -- turn up expecting it and find the listing now says somewhere else, having never
  -- been asked. The amendment flow is per-booking consent; the guard treated it as
  -- per-job.
  --
  -- `not exists (a live booking WITHOUT an accepted amendment)` is the per-booking
  -- reading: unanimous consent among the parties actually affected. Single-booking
  -- gigs — the common case — behave exactly as before.
  select not exists (
    select 1 from public.bookings b
    where b.job_id = old.id
      and b.status in ('confirmed', 'completed', 'verified')
      and coalesce(b.amendment_status, 'none') <> 'accepted'
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

drop trigger if exists trg_guard_jobs_write on public.jobs;
create trigger trg_guard_jobs_write
  before update on public.jobs
  for each row execute function public.guard_jobs_write();
