-- ─────────────────────────────────────────────────────────────────────────────
-- H2 (block-not-server-enforced): make "Block" a real, server-enforced control
-- (2026-07-10).
--
-- Before this, blocking was UI-only: no RLS/trigger consulted the `blocks` table on
-- message or booking insert, so a blocked user kept messaging the blocker and could
-- still book the blocker's gigs — while the dialog told the user "they can't reach
-- you here." Enforcement is BIDIRECTIONAL: if EITHER party has blocked the other,
-- the two can neither message within a booking nor open a new booking together.
--
-- Two enforcement points:
--   1. messages_insert RLS — redefined to also require no block between the two
--      booking parties (earner & poster), independent of who is sending.
--   2. bookings BEFORE INSERT trigger — rejects a new booking between a blocked pair.
-- Service role (admin/system) bypasses both.
-- ─────────────────────────────────────────────────────────────────────────────

-- Block lookup helper. Two requirements shape it:
--   (a) SECURITY DEFINER — the `blocks` table has RLS with only an owner-scoped SELECT
--       policy (blocks_select_own = auth.uid() = blocker_id), so an INLINE subquery in
--       an RLS policy (which runs as the querying role) would only see the CALLER's own
--       block rows and silently fail to stop the BLOCKED party. Running as the owner
--       bypasses blocks-RLS and sees both directions, like guard_booking_not_blocked.
--   (b) Housed in a NON-exposed `private` schema — PostgREST only serves the `public`
--       schema, so the policy can call it but it is NOT reachable as an
--       `/rest/v1/rpc/...` endpoint. In `public` + granted to `authenticated` with
--       caller-controlled args it would be a boolean ORACLE over any two users' block
--       relationship (and would let a blocked user confirm the block, defeating the
--       silent block). `private` closes that while keeping the policy able to evaluate.
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_blocked_pair(a uuid, b uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.blocks bl
    where (bl.blocker_id = a and bl.blocked_id = b)
       or (bl.blocker_id = b and bl.blocked_id = a)
  );
$$;
revoke execute on function private.is_blocked_pair(uuid, uuid) from public, anon;
grant execute on function private.is_blocked_pair(uuid, uuid) to authenticated;

-- 1. Messages: sender must be a party to the booking AND the two parties must not be
--    blocked in either direction. (Redefines the party-scoped policy from
--    migration_security_hardening.sql / migration_fix_lifecycle.sql, adding the block
--    clause — same party condition otherwise. The block check goes through the
--    private SECURITY DEFINER helper so it isn't defeated by blocks-RLS; see above.)
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id
      and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
      and not private.is_blocked_pair(b.earner_id, j.poster_id)
  )
);

-- 2. Bookings: reject a new booking between a blocked pair (either direction). A
--    dedicated BEFORE INSERT trigger so we don't have to re-declare the large
--    guard_bookings_write function; both are independent BEFORE INSERT validators.
create or replace function public.guard_booking_not_blocked()
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
  select poster_id into poster from public.jobs where id = new.job_id;
  if poster is not null and exists (
    select 1 from public.blocks bl
    where (bl.blocker_id = new.earner_id and bl.blocked_id = poster)
       or (bl.blocker_id = poster and bl.blocked_id = new.earner_id)
  ) then
    raise exception 'You cannot book this gig.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Trigger functions must not be directly callable by clients.
revoke execute on function public.guard_booking_not_blocked() from public, anon, authenticated;

drop trigger if exists trg_guard_booking_not_blocked on public.bookings;
create trigger trg_guard_booking_not_blocked
  before insert on public.bookings
  for each row execute function public.guard_booking_not_blocked();
