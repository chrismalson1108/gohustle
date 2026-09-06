-- ─────────────────────────────────────────────────────────────────────────────
-- A poster can pin their own listing to the top of every feed forever, and the
-- guard that says it prevents this pins the wrong table.
--
-- 20260715100000 put a 24h cooldown on bumped_at, and 20260726100000 closed the two
-- ways that cooldown could be inverted into a permanent pin. That second migration
-- also noticed the OTHER ordering key and wrote:
--
--     -- created_at is the other ordering key the Browse feed falls back on; a future
--     -- value pins a listing the same way. Clamp it on INSERT only — 20260722020000
--     -- pins it against edits on UPDATE, and this must not fight that guard.
--     if tg_op = 'INSERT' and new.created_at is not null and new.created_at > now() then
--
-- 20260722020000 is `guard_profiles_write`. It pins profiles.created_at — the age-floor
-- cutoff input — and has nothing to do with jobs. Nothing has ever pinned
-- jobs.created_at on UPDATE. The live guard_jobs_write (20260726110000) handles
-- bumped_at, pay, pay_type, estimated_hours and the conditionally-locked core terms;
-- the string `created_at` does not appear in it. So the clamp deliberately skipped the
-- UPDATE path on the strength of a guard that does not exist, and the INSERT-only
-- half is the only half there is.
--
-- UPDATE on public.jobs is granted table-wide to `authenticated` (only DELETE and
-- anon SELECT were ever revoked), and jobs_update_own is USING-only with no WITH CHECK
-- and no column list. So a poster sends, with their own token:
--
--     PATCH /rest/v1/jobs?id=eq.<own job>  {"created_at": "2099-01-01T00:00:00Z"}
--
-- and it is stored. Every feed that orders on created_at then puts that listing first,
-- permanently and for free:
--   · web/lib/jobs.tsx:357            .order("created_at", { ascending: false })
--   · assistant searchGigs :738       .order('created_at', { ascending: false })
--   · src/context/JobsContext.js:255  the mobile browse fetch, server-side
--   · shared/filters.js:368           the 'newest' sort, freshness = bumpedAt || createdAt
-- On mobile it also needs bumped_at nulled or aged out, which the cooldown permits the
-- moment the last bump is over 24h old. The listing also renders "Posted Jan 1 2099"
-- through shared/transforms.js:43.
--
-- The point is not that one field is unpinned. It is that the 24h bump cooldown — added
-- specifically to stop feed-gaming — is bypassed by a field the cooldown never looks at,
-- so the whole control is decorative for anyone who reads the schema.
--
-- Fix: pin created_at in guard_jobs_write, immediately after the bump-cooldown block and
-- BEFORE the `if not has_active then return new` early return. That placement is
-- load-bearing: the early return is what lets a poster edit a gig nobody has booked,
-- which is exactly the gig an attacker would use. No client anywhere writes
-- jobs.created_at, so the pin is lossless.
--
-- The function is otherwise reproduced byte-for-byte from 20260726110000 (the live
-- definition), and guard_jobs_bump_not_future is re-created solely to correct the
-- comment that sent the last reader to the wrong table — that text lives in pg_proc, so
-- leaving it there leaves the false claim in the database.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── First, prove the hole is real on the CURRENTLY-LIVE function ────────────
do $$
declare
  uid uuid; jid uuid; got timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'created_at pin probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- Become the gig's own poster: the exact call the app is allowed to make.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.jobs set created_at = timestamptz '2099-01-01 00:00:00+00' where id = jid;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select created_at into got from public.jobs where id = jid;

  if got <= now() then
    raise exception 'nothing to fix: the live guard already refused a forged created_at (%)', got;
  end if;
  raise notice 'hole confirmed on the live function: created_at is now %, which sorts first in every feed forever', got;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'pre-fix probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;


-- ── The fix ─────────────────────────────────────────────────────────────────
-- Reproduced from 20260726110000 with ONE addition: the created_at pin.
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

  -- created_at is the OTHER key the feeds order on — web and the assistant order on it
  -- alone, and shared/filters.js falls back to it whenever bumped_at is null. It was
  -- clamped on INSERT by 20260726100000 and never pinned on UPDATE: that migration's
  -- comment cited 20260722020000 as covering the UPDATE case, but that migration pins
  -- profiles.created_at (the age-floor input), not jobs.created_at. So a poster could
  -- PATCH their own row to a far-future date and sit at the top of every feed forever,
  -- for free, defeating the bump cooldown by never touching bumped_at at all.
  --
  -- Pinned HERE — above the has_active early return — on purpose: a gig with no live
  -- booking is the one a poster may otherwise edit freely, and it is precisely the gig
  -- someone would forge. Nothing in the app writes this column, so the pin costs nothing.
  new.created_at := old.created_at;

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


-- Same body as 20260726100000; only the comment changes. It named the wrong migration
-- and the wrong table as the reason for skipping UPDATE, and that text is stored in
-- pg_proc — so correcting it here is what stops the next reader re-deriving the same
-- wrong conclusion from the database itself.
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
  -- pins a listing the same way. Clamped on INSERT only because guard_jobs_write does
  -- not run at INSERT; on UPDATE that function PINS created_at to the stored value
  -- outright, which is stricter than a clamp.
  --
  -- This comment used to justify the INSERT-only scope by naming migration
  -- 20260722020000 as the one covering UPDATE. That migration is guard_profiles_write
  -- and pins PROFILES.created_at — the age-floor cutoff input. Nothing pinned
  -- jobs.created_at on UPDATE until 20260906043000, and for six weeks any poster could
  -- PATCH it to 2099 and outrank every honest listing forever.
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


-- Backfill: 20260726100000 pulled future created_at values back once, but only the
-- INSERT path stayed closed, so anything forged by an UPDATE since then is still
-- sitting above every honest listing. `now()` is the only defensible upper bound (the
-- real value is gone), floored further by bumped_at where there is one — a gig cannot
-- have been created after it was last bumped, and using it avoids handing a forged row
-- a fresh day at the top of the feed as its reward.
--
-- The claims dance is not decoration: the pin above applies to any caller whose
-- auth.role() is not 'service_role', and a migration session has NO claims set at all,
-- so an unqualified backfill UPDATE would be pinned back to the forged value by the
-- very fix it is cleaning up after, and report success while changing nothing.
do $$
declare
  n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  with fixed as (
    update public.jobs
       set created_at = least(now(), coalesce(bumped_at, now()))
     where created_at > now()
     returning 1
  )
  select count(*) into n from fixed;
  if n > 0 then
    raise notice 'backfill: pulled % job(s) back from a future created_at', n;
  end if;

  if exists (select 1 from public.jobs where created_at > now()) then
    raise exception 'backfill did not land — a job still carries a future created_at';
  end if;

  perform set_config('request.jwt.claims', '', true);
end $$;


-- ── Now prove the fix closes it, on the same staged shape ───────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid;
  before_ts timestamptz; got timestamptz; got_title text; got_bump timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'created_at pin probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;
  select created_at into before_ts from public.jobs where id = jid;

  -- The attack, as the gig's own poster. No live booking, so this takes the
  -- `not has_active` path — the one the pin has to sit above.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.jobs set created_at = timestamptz '2099-01-01 00:00:00+00' where id = jid;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select created_at into got from public.jobs where id = jid;
  if got is distinct from before_ts then
    raise exception 'FIX FAILED: created_at moved to % on an unbooked gig', got;
  end if;
  raise notice 'discriminates: the same PATCH that stored 2099 above now leaves created_at at %', got;

  -- Backdating is refused too. It is harmless to the feed but it forges "Posted"
  -- and the pin is absolute, so assert the property rather than one direction of it.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.jobs set created_at = now() - interval '400 days' where id = jid;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select created_at into got from public.jobs where id = jid;
  if got is distinct from before_ts then
    raise exception 'FIX FAILED: created_at accepted a backdated value (%)', got;
  end if;

  -- The pin must not have swallowed the edits a poster is entitled to make. An
  -- unbooked gig is freely editable, and an honest first bump still lands.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.jobs
     set title = 'renamed by the poster', bumped_at = now()
   where id = jid;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select title, bumped_at into got_title, got_bump from public.jobs where id = jid;
  if got_title <> 'renamed by the poster' then
    raise exception 'the pin broke a legitimate edit: title is %', got_title;
  end if;
  if got_bump is null then
    raise exception 'the pin broke a legitimate first bump';
  end if;
  raise notice 'a legitimate rename and first bump still land, so the pin is lossless';

  -- And it holds on the OTHER path through the function — a gig with a live booking,
  -- which returns further down and must not be relying on the early return.
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'confirmed')
  returning id into bid;
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.jobs set created_at = timestamptz '2099-01-01 00:00:00+00' where id = jid;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select created_at into got from public.jobs where id = jid;
  if got is distinct from before_ts then
    raise exception 'FIX FAILED: a booked gig still accepted a forged created_at (%)', got;
  end if;
  raise notice 'held on the booked-gig path too, at %', got;

  -- Nothing is left in a future state anywhere.
  if exists (select 1 from public.jobs where created_at > now()) then
    raise exception 'a job still carries a future created_at after the backfill';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'created_at pin probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
