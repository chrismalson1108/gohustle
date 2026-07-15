-- C47 (server-side bump cooldown): a poster "bumps" a gig to the top of Browse by
-- writing jobs.bumped_at. Nothing server-side rate-limits it, so a poster could bump
-- repeatedly and dominate the feed. Enforce one bump per 24h in the write guard.
--
-- guard_jobs_write is recreated FAITHFULLY from the authoritative definition in
-- 20260702030000_guard_pins_and_slot_delete_policies.sql — every existing pin/behavior
-- is preserved verbatim. The ONLY addition is the bump-cooldown block, placed after the
-- service_role bypass and before any other logic so it applies to every poster edit
-- regardless of booking state (bumping is orthogonal to whether a booking is live).
-- Idempotent via CREATE OR REPLACE FUNCTION.

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
