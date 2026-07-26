-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM, safety): make suspension actually cascade (2026-07-26).
--
-- The admin "Suspend" action bans the auth user, flags profiles.suspended_at and
-- revokes live sessions — so the suspended person cannot sign in. But nothing else
-- consults suspended_at:
--
--   * jobs_select_all is USING(true) (schema.sql:133), so a suspended poster's open
--     listings stay visible in Browse and remain bookable by anyone.
--   * the bookings insert guard only checks the blocks table, so a booking can still
--     be created against a suspended counterparty.
--
-- Suspension is the platform's safety kill switch — it is used precisely when someone
-- is believed to be a risk to other users. Leaving their gigs live and bookable means
-- the suspension stops them logging in but does not stop them being matched with more
-- people, and a booking made after suspension has a counterparty who cannot log in to
-- perform, confirm, or settle it.
--
-- Two enforcement points, mirroring how blocks were made real in 20260710030000:
--   1. jobs_select_all — hide a suspended poster's listings from everyone EXCEPT the
--      poster themselves (they should still see their own gigs and understand the
--      state) and service_role (admin console).
--   2. guard_booking_not_suspended — BEFORE INSERT on bookings, reject when either
--      party is suspended.
--
-- Deliberately hiding rather than cancelling: suspension can be lifted (unsuspend
-- exists and clears suspended_at), and cancelling would destroy the listings
-- irreversibly. Hiding restores automatically on unsuspend.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- Index so the per-row suspension probe stays cheap on the Browse query path.
create index if not exists profiles_suspended_at_idx
  on public.profiles (id) where suspended_at is not null;

-- Suspension lookup helper. SECURITY DEFINER and housed in the non-exposed `private`
-- schema, for the same two reasons private.is_blocked_pair is (20260710030000):
--   (a) an INLINE subquery in an RLS policy is evaluated as the QUERYING role, and
--       profiles.suspended_at is not in the column-level SELECT grant
--       (20260624221000_profile_column_lockdown.sql) — so an inline probe risks
--       failing on column privileges and taking every jobs read down with it.
--       Running as the owner sidesteps column grants entirely.
--   (b) `private` is not served by PostgREST, so this cannot be called as
--       /rest/v1/rpc/... and turned into an oracle over who is suspended.
create or replace function private.is_suspended(u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p where p.id = u and p.suspended_at is not null
  );
$$;

revoke execute on function private.is_suspended(uuid) from public, anon;
grant execute on function private.is_suspended(uuid) to authenticated;

-- 1. Suspended posters' gigs disappear from everyone else's Browse.
drop policy if exists "jobs_select_all" on public.jobs;
create policy "jobs_select_all" on public.jobs for select
  using (
    poster_id = auth.uid()
    or not private.is_suspended(jobs.poster_id)
  );

-- 2. No new bookings involving a suspended party, in either direction.
create or replace function public.guard_booking_not_suspended()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  poster uuid;
begin
  -- Admin/system writes bypass, matching every other guard_*.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if private.is_suspended(new.earner_id) then
    raise exception 'This account is suspended and cannot book gigs.'
      using errcode = 'check_violation';
  end if;

  select poster_id into poster from public.jobs where id = new.job_id;
  if poster is not null and private.is_suspended(poster) then
    raise exception 'This gig is no longer available.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_booking_not_suspended() from public, anon, authenticated;

drop trigger if exists trg_guard_booking_not_suspended on public.bookings;
create trigger trg_guard_booking_not_suspended
  before insert on public.bookings
  for each row execute function public.guard_booking_not_suspended();

-- Verify post-deploy:
--   * suspend a test poster -> their open gigs vanish from another user's
--     /rest/v1/jobs, but are still returned to the poster themselves
--   * booking one of their gigs -> check_violation
--   * unsuspend -> the gigs reappear (nothing was destroyed)
