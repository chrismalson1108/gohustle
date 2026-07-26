-- ─────────────────────────────────────────────────────────────────────────────
-- Correctness (MEDIUM, abuse): the bump cooldown was permanently defeatable
-- (2026-07-26).
--
-- 20260715100000 added a 24h bump cooldown inside guard_jobs_write:
--
--     if new.bumped_at is distinct from old.bumped_at
--        and old.bumped_at is not null
--        and old.bumped_at > now() - interval '24 hours' then
--       new.bumped_at := old.bumped_at;   -- silently revert
--     end if;
--
-- Two gaps, and they compose into a permanent pin at the top of Browse:
--
--   1. trg_guard_jobs_write is `before update on public.jobs` only. At INSERT there
--      is no OLD row and no trigger, so bumped_at is entirely unconstrained on the
--      first write — a poster can create a gig with any value they like.
--
--   2. Nothing bounds bumped_at to the present. Set it to a FAR-FUTURE timestamp and
--      the cooldown inverts into a lock: every later write sees
--      `old.bumped_at > now() - 24h` (a 2030 date trivially satisfies that), so the
--      guard reverts to the stored future value every time. The gig now sorts above
--      every honestly-bumped listing, forever, and the cooldown itself is what keeps
--      it there.
--
-- Fix: clamp bumped_at to now() on INSERT and UPDATE. A future bump is meaningless by
-- definition — bumping means "I refreshed this listing just now" — so clamping is
-- lossless for every legitimate use and removes both the INSERT hole and the
-- future-date lock in one predicate.
--
-- Implemented as its own small trigger rather than by widening guard_jobs_write to
-- INSERT: that function's whole body is written against OLD (it pins core terms
-- against the previously-stored row) and firing it on INSERT would dereference a NULL
-- OLD. Named to sort AFTER trg_guard_jobs_write so on UPDATE the cooldown's revert
-- runs first and this clamp then applies to whatever survived it.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_jobs_bump_not_future()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Admin/system writes bypass, matching every other guard_*.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- A bump can never be in the future. Covers INSERT (where guard_jobs_write does not
  -- run at all) and UPDATE (where a future value would otherwise pin the row forever).
  if new.bumped_at is not null and new.bumped_at > now() then
    new.bumped_at := now();
  end if;

  -- created_at is the other ordering key the Browse feed falls back on; a future value
  -- pins a listing the same way. Clamp it on INSERT only — 20260722020000 pins it
  -- against edits on UPDATE, and this must not fight that guard.
  if tg_op = 'INSERT' and new.created_at is not null and new.created_at > now() then
    new.created_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_jobs_bump_not_future() from public, anon, authenticated;

-- 'z_' prefix so this sorts AFTER trg_guard_jobs_write (triggers fire in name order):
-- on UPDATE the cooldown revert runs first, then this clamps whatever survived.
drop trigger if exists trg_z_guard_jobs_bump_not_future on public.jobs;
create trigger trg_z_guard_jobs_bump_not_future
  before insert or update on public.jobs
  for each row execute function public.guard_jobs_bump_not_future();

-- Backfill: pull any already-future timestamps back to now so an existing pinned gig
-- stops outranking everything.
update public.jobs set bumped_at = now() where bumped_at > now();
update public.jobs set created_at = now() where created_at > now();

-- Verify post-deploy:
--   POST  /rest/v1/jobs  {... "bumped_at":"2030-01-01T00:00:00Z" ...}  -> stored as now()
--   PATCH /rest/v1/jobs?id=eq.X {"bumped_at":"2030-01-01T00:00:00Z"}   -> stored as now()
--   and an honest bump (>24h since the last one) still moves bumped_at forward.
