-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing watched the one regression CLAUDE.md says "publishes every street address
-- on the platform" (2026-09-06).
--
-- The whole in-person safety posture rests on ONE moving part. `jobs.location` is a
-- masked, city-level label; the exact street address lives in `job_locations` behind
-- a policy that reveals it to the poster and — only once their booking is accepted —
-- to the earner. The thing that puts it there is a single BEFORE trigger:
--
--     trg_mask_job_location -> capture_job_location()   (20260730180000:19-67)
--         masked := public.mask_location(new.location);
--         if masked is distinct from new.location then
--             insert into job_locations ...;  new.location := masked;
--
-- There is no CHECK constraint behind it, no masking view, and `jobs_select_all` is
-- USING(true) modulo the suspended-poster carve-out (20260726070000:62-63). So the
-- trigger is not the first line of defence, it is the only one. Drop it, recreate one
-- of the four superseded definitions of capture_job_location, add an early return for
-- some role, or run a single write with the trigger disabled, and
-- "742 Evergreen Terrace, Springfield, IL" is published verbatim to every signed-in
-- user — with no error, no failing test and no finding. It propagates, too:
-- view_gig_share falls back to `coalesce(exact, r.location)`, so the share link a
-- worker sends a friend carries it as well.
--
-- This repo already answers exactly this class of risk with a canary control — for a
-- policy (ctl_support_intake_writable), for a grant (ctl_client_holds_truncate), for a
-- trigger (ctl_booking_status_contradicts_done_flags). The address masker had none:
--     grep -n 'mask_location\|job_locations' supabase/migrations/*.sql | grep -i ctl_
-- returned nothing. The nearest thing to coverage is parity.test.js's "the
-- address-masking contract is documented", whose banner claims to keep the contract
-- "wired" while asserting only that CLAUDE.md still describes it in prose. A doc test
-- cannot see a dropped trigger.
--
-- ── WHY THE INVARIANT IS SAFE TO ASSERT AGAINST DATA ────────────────────────
-- mask_location (20260726030000:42-70) splits on commas and drops every segment that
-- carries a digit or ends in a street/unit keyword, then joins the survivors (or
-- returns 'Nearby area'). Every surviving segment therefore carries no digit and no
-- trailing keyword, so re-splitting the joined result yields the same segments and
-- they all survive again: mask(mask(x)) = mask(x), for every x. That makes
--
--     jobs.location = mask_location(jobs.location)
--
-- true of every correctly masked row and false of every unmasked one. It is a canary
-- with no false-positive population, and it is cheap: one immutable call per row.
--
-- The control calls public.mask_location itself rather than re-implementing the test,
-- deliberately. A hand-rolled regex here would be a SECOND definition of what counts
-- as an address, free to drift from the one the trigger enforces — and the drift would
-- be silent in the safe-looking direction. __tests__/jobLocationUnmasked.test.js fails
-- if this body stops calling the masker.
--
-- ── TWO DEVIATIONS FROM THE OBVIOUS SHAPE, BOTH LOAD-BEARING ────────────────
--  * No `status = 'open'` filter. jobs_select_all does not mention status, so a
--    'booked', 'completed' or 'cancelled' row is just as readable as an open one and
--    an address leaked there is leaked the same. Scoping the canary to open gigs would
--    mean the trigger could be dropped and every gig that filled in the meantime would
--    go unreported.
--  * `btrim(location) = ''` is excluded, mirroring capture_job_location's own early
--    return. mask_location('') is 'Nearby area', so without this the control would
--    report a blank-location row the trigger deliberately never touched — noise on a
--    healthy row, which is how a control gets muted and then deleted.
--
-- The coordinate arm rides along in the SAME row rather than a second one: the finding
-- upsert in run_control is `insert ... select from v on conflict do update`, which
-- raises a cardinality violation if one entity_id appears twice in a single run. One
-- row per job, with `arms` naming what tripped.
--
-- The detail reports how many decimals the coordinates carry, not the coordinates. A
-- finding about a leaked home location should not copy that location into a second
-- table in order to say so; the job id is enough to look it up.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_job_location_unmasked()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select j.id::text,
         jsonb_build_object(
           'arms', (case when j.location is distinct from public.mask_location(j.location)
                         then array['label'] else array[]::text[] end)
                   || (case when (j.lat is not null and j.lat::numeric is distinct from round(j.lat::numeric, 2))
                              or (j.lng is not null and j.lng::numeric is distinct from round(j.lng::numeric, 2))
                            then array['coords'] else array[]::text[] end),
           'poster_id', j.poster_id,
           'job_status', j.status,
           'stored', left(j.location, 80),
           'masked_would_be', left(public.mask_location(j.location), 80),
           'exact_captured', exists (select 1 from public.job_locations l where l.job_id = j.id),
           -- Values deliberately omitted: a leaked location is not made safer by being
           -- copied here. Precision is what says whether the snap ran.
           'lat_decimals', coalesce(length(split_part(j.lat::numeric::text, '.', 2)), 0),
           'lng_decimals', coalesce(length(split_part(j.lng::numeric::text, '.', 2)), 0),
           'note', 'jobs.location is published to every signed-in user and is supposed to '
                   'be city-level: trg_mask_job_location -> capture_job_location() rewrites '
                   'it to mask_location(location) on every write and files the exact label '
                   'in job_locations behind RLS. This row is stored UNMASKED (or with '
                   'un-snapped coordinates), which means that trigger did not run on it. '
                   'Nothing else enforces this — there is no constraint behind it.',
           'remedy', 'Treat as a live disclosure. Confirm the trigger still exists, is '
                     'enabled and still points at the current capture_job_location: '
                     'select tgname, tgenabled from pg_trigger where tgrelid = '
                     '''public.jobs''::regclass. If it was dropped, weakened or disabled, '
                     'restore it with a migration, then repair the affected rows by making '
                     'the trigger do its own capture-and-mask: update public.jobs set '
                     'location = location || '' '' where id = $1; then update '
                     'public.job_locations set exact_location = btrim(exact_location) '
                     'where job_id = $1. Two things that look like repairs and are not: '
                     'a no-op touch (set location = location) early-returns unchanged '
                     '(20260730180000) and only rounds the coordinates, so it looks like '
                     'it worked; and set location = mask_location(location) DESTROYS the '
                     'address, because the trigger reads a city-only label as a '
                     'retraction and deletes the job_locations row — on a leaked row '
                     'that is the only copy of the address the accepted earner needs in '
                     'order to turn up.'
         )
    from public.jobs j
   where j.location is not null
     -- Mirrors capture_job_location's own early return, or a blank label reads as a
     -- violation ('' masks to 'Nearby area') on a row the trigger never touched.
     and btrim(j.location) <> ''
     and (
          j.location is distinct from public.mask_location(j.location)
       or (j.lat is not null and j.lat::numeric is distinct from round(j.lat::numeric, 2))
       or (j.lng is not null and j.lng::numeric is distinct from round(j.lng::numeric, 2))
     )
$$;

revoke execute on function public.ctl_job_location_unmasked() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('job_location_unmasked',
   'A published gig carries an unmasked street address',
   'critical', 'security',
   'jobs.location is readable by every signed-in user and is supposed to hold only a '
   'city-level label; the exact address belongs in job_locations, revealed to the poster '
   'and to an earner only once their booking is accepted. ONE before-trigger '
   '(trg_mask_job_location -> capture_job_location) enforces that, with no constraint '
   'behind it, so dropping it, restoring an older definition of the function, or writing '
   'with it disabled publishes home addresses platform-wide in silence. mask_location is '
   'idempotent, so location = mask_location(location) holds on every correctly masked row '
   'and fails on exactly the leaked ones. A second arm catches the coordinate snap in the '
   'same function going with it.',
   'ctl_job_location_unmasked')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove the canary fires on the regression it exists for, and only on it ───
do $$
declare
  uid uuid; healthy uuid; leaked uuid;
  n int; stored text; got_lat double precision; d jsonb;
  street constant text := '742 Evergreen Terrace, Springfield, IL';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- 1. The healthy path. Trigger on: the address is captured and the public column is
  --    masked, so the canary must stay silent. If this ever fires, the control is noise.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location,
                           description, status, lat, lng)
  values (uid, 'address masking canary probe', 'Odd Jobs', 100, 'flat', street,
          'probe', 'open', 37.774929, -122.419416)
  returning id into healthy;

  select location, lat into stored, got_lat from public.jobs where id = healthy;
  if stored = street then
    raise exception 'the masker did not run on a normal insert — the leak is ALREADY live (stored %)', stored;
  end if;
  if got_lat::numeric is distinct from round(got_lat::numeric, 2) then
    raise exception 'coordinates were not snapped on a normal insert (lat %)', got_lat;
  end if;
  if not exists (select 1 from public.job_locations where job_id = healthy) then
    raise exception 'the exact address was masked away without being captured';
  end if;

  select count(*) into n from public.ctl_job_location_unmasked() where entity_id = healthy::text;
  if n <> 0 then
    raise exception 'fired on a correctly masked gig — permanent noise (% rows)', n;
  end if;
  raise notice 'a correctly masked gig is silent, so the canary has no false-positive population';

  -- 2. THE REGRESSION. Exactly what a dropped, weakened or bypassed trigger produces:
  --    the street address sitting in the public column, coordinates unsnapped.
  execute 'alter table public.jobs disable trigger trg_mask_job_location';
  insert into public.jobs (poster_id, title, category, pay, pay_type, location,
                           description, status, lat, lng)
  values (uid, 'address masking canary probe (unguarded)', 'Odd Jobs', 100, 'flat', street,
          'probe', 'open', 37.774929, -122.419416)
  returning id into leaked;
  execute 'alter table public.jobs enable trigger trg_mask_job_location';

  select location into stored from public.jobs where id = leaked;
  if stored is distinct from street then
    raise exception 'could not stage the broken row; the probe would prove nothing (stored %)', stored;
  end if;

  select count(*) into n from public.ctl_job_location_unmasked() where entity_id = leaked::text;
  if n <> 1 then
    raise exception 'FIX FAILED: an unmasked street address reported % rows', n;
  end if;
  raise notice 'discriminates: the same insert is silent with the trigger on and reported with it off';

  -- One row, not two, even though both arms tripped: run_control upserts the whole
  -- output in a single statement and a repeated entity_id is a cardinality violation.
  select detail into d from public.ctl_job_location_unmasked() where entity_id = leaked::text;
  if not ((d -> 'arms') ? 'label' and (d -> 'arms') ? 'coords') then
    raise exception 'both arms tripped but the finding names %', d -> 'arms';
  end if;
  if d ->> 'masked_would_be' is distinct from left(public.mask_location(street), 80) then
    raise exception 'the finding does not quote the answer mask_location itself gives (%)', d ->> 'masked_would_be';
  end if;
  raise notice 'the finding names both arms in one row and quotes mask_location itself';

  -- 3. Repairing it the documented way — touch the row so the live trigger re-runs —
  --    closes the finding, so it auto-resolves instead of sitting open forever.
  -- The repair the finding prescribes. Getting here took two wrong answers, both of
  -- which this probe rejected, and both are why the remedy text is now specific:
  --   · A no-op touch (set location = location) does nothing. capture_job_location
  --     early-returns on an UPDATE whose location is unchanged (20260730180000) — it
  --     still rounds the coordinates, so it LOOKS like it worked.
  --   · Masking the column directly (set location = mask_location(location)) destroys
  --     the address. The trigger's else-branch reads a city-only label as a retraction
  --     and DELETES the job_locations row, which on a leaked row is the only copy.
  -- So the label has to change while still carrying the exact detail, and the trigger
  -- must be the thing that captures and masks it — one statement, its own transaction.
  update public.jobs set location = location || ' ' where id = leaked;
  update public.job_locations set exact_location = btrim(exact_location) where job_id = leaked;

  if not exists (select 1 from public.job_locations where job_id = leaked) then
    raise exception 'the repair masked the column without capturing the exact label — the earner can no longer find the gig';
  end if;

  select count(*) into n from public.ctl_job_location_unmasked() where entity_id = leaked::text;
  if n <> 0 then
    select detail into d from public.ctl_job_location_unmasked() where entity_id = leaked::text;
    raise exception 'the prescribed repair left the finding open — it could never auto-resolve (% rows). stored=% arms=%',
      n, (select location from public.jobs where id = leaked), d -> 'arms';
  end if;
  if not exists (select 1 from public.job_locations where job_id = leaked) then
    raise exception 'the repair discarded the exact address instead of capturing it';
  end if;
  raise notice 'touching the row re-masks it, captures the exact label and resolves the finding';

  -- 4. A blank label is the early-return case capture_job_location has, not a violation.
  update public.jobs set location = '   ' where id = leaked;
  select count(*) into n from public.ctl_job_location_unmasked() where entity_id = leaked::text;
  if n <> 0 then
    raise exception 'reported a blank location the trigger deliberately never touches';
  end if;
  raise notice 'a blank location stays off the board, matching the early return in the trigger';

  if not exists (select 1 from public.controls
                  where key = 'job_location_unmasked' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'address-masking canary probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
