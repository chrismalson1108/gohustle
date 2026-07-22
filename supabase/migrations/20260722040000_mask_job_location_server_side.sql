-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM, privacy-pii): enforce job address masking SERVER-SIDE
-- (2026-07-22).
--
-- jobs.location is free text a poster can type a full street address into
-- ("123 Main St, Dallas, TX"). The privacy design (src/lib/address.js
-- maskLocation/canSeeExactAddress, mirrored in web/lib/address.ts) hides the exact
-- address from anyone who has not been accepted onto the booking — but that masking
-- ran ONLY in the client render layer. The data layer served the raw column:
-- jobs_select_all is USING(true) and, unlike profiles (20260624221000 column
-- lockdown), jobs never got a column-scoped grant, so any signed-in user could
-- GET /rest/v1/jobs?select=location and read every job's exact typed address before
-- booking/acceptance. lat/lng were already coarsened to ~1.1km at write; the free-text
-- label was not. The 20260710020000 note flagged column-trimming as the open follow-up.
--
-- Fix: mask jobs.location at WRITE time and keep the exact address in a separate,
-- RLS-gated table readable only by the poster or an accepted earner.
--   1. public.mask_location(text)  — SQL port of maskLocation (city-level reduction).
--   2. public.job_locations        — (job_id, exact_location); RLS party-read only;
--                                     NO client write grant (populated by the trigger).
--   3. trg_mask_job_location       — BEFORE INSERT/UPDATE on jobs, fires LAST (name
--                                     sorts after trg_guard_*): captures the exact
--                                     label into job_locations and overwrites
--                                     jobs.location with the masked form; also snaps
--                                     lat/lng to 2 decimals server-side.
--   4. Backfill: UPDATE jobs SET location = location fires the trigger for every row,
--      capturing the current exact label before it is masked in place (reversible —
--      the exact value is preserved in job_locations, never dropped).
-- The client render-mask stays as defense-in-depth. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. City-level reduction — faithful port of maskLocation (src/lib/address.js).
--    Drops comma segments that contain a digit OR end with a street/unit keyword;
--    keeps city/state segments; 'remote' passes through; nothing kept => 'Nearby area'.
create or replace function public.mask_location(loc text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  seg  text;
  kept text[] := '{}';
begin
  if loc is null then return null; end if;
  if position('remote' in lower(loc)) > 0 then return loc; end if;
  foreach seg in array string_to_array(loc, ',') loop
    seg := btrim(seg);
    if seg = '' then continue; end if;
    if seg ~ '\d' then continue; end if;  -- street lines carry a number
    -- ...or END with a spelled-out street/unit keyword ("Main Street", "Apt", "Ste").
    if seg ~* '\y(st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|dr|drive|ct|court|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway|trl|trail|apt|apartment|ste|suite|unit|fl|floor|rm|room)\y\.?$' then
      continue;
    end if;
    kept := array_append(kept, seg);
  end loop;
  if coalesce(array_length(kept, 1), 0) >= 1 then
    return array_to_string(kept, ', ');
  end if;
  return 'Nearby area';
end;
$$;

-- 2. Exact-address store. RLS: readable only by the job's poster or an earner with an
--    accepted (confirmed+) booking. No client INSERT/UPDATE/DELETE grant — only the
--    SECURITY DEFINER trigger (runs as owner) and service_role write it.
-- The FK is DEFERRABLE INITIALLY DEFERRED: capture_job_location is a BEFORE INSERT
-- trigger that writes job_locations referencing new.id while the parent jobs row is
-- still mid-insert, so a non-deferrable FK would fail foreign_key_violation and block
-- posting any street-address gig. Deferring the check to COMMIT (by when the jobs row
-- exists) fixes that; ON DELETE CASCADE still cleans up orphans.
create table if not exists public.job_locations (
  job_id         uuid primary key references public.jobs(id) on delete cascade deferrable initially deferred,
  exact_location text,
  updated_at     timestamptz not null default now()
);
alter table public.job_locations enable row level security;

drop policy if exists "job_locations_party_read" on public.job_locations;
create policy "job_locations_party_read" on public.job_locations
  for select to authenticated
  using (
    exists (select 1 from public.jobs j where j.id = job_locations.job_id and j.poster_id = auth.uid())
    or exists (
      select 1 from public.bookings b
      where b.job_id = job_locations.job_id
        and b.earner_id = auth.uid()
        and b.status in ('confirmed', 'completed', 'verified')
    )
  );

revoke all on public.job_locations from anon, authenticated;
grant select on public.job_locations to authenticated;  -- RLS scopes it to the parties
grant all  on public.job_locations to service_role;

-- 3. Capture + mask trigger. Named to sort AFTER trg_guard_jobs_write so it runs last:
--    guard pins fields (incl. reverting a mid-booking location edit to old) BEFORE we
--    mask. Only captures when the incoming label actually carries exact detail
--    (mask(x) <> x), so a guard-reverted or already-masked value never clobbers the
--    stored exact address.
create or replace function public.capture_job_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  masked text;
begin
  -- Defense-in-depth: snap coords to ~1.1km server-side too (clients already do).
  if new.lat is not null then new.lat := round(new.lat::numeric, 2); end if;
  if new.lng is not null then new.lng := round(new.lng::numeric, 2); end if;

  if new.location is null or btrim(new.location) = '' then
    return new;
  end if;
  masked := public.mask_location(new.location);
  -- Only an incoming EXACT label (differs from its masked form) is captured/masked;
  -- an already-masked or guard-reverted value is left as-is so we never overwrite the
  -- stored exact address with a city-level string.
  if masked is distinct from new.location then
    insert into public.job_locations (job_id, exact_location, updated_at)
    values (new.id, new.location, now())
    on conflict (job_id) do update set exact_location = excluded.exact_location, updated_at = now();
    new.location := masked;
  end if;
  return new;
end;
$$;

revoke execute on function public.capture_job_location() from public, anon, authenticated;

drop trigger if exists trg_mask_job_location on public.jobs;
create trigger trg_mask_job_location
  before insert or update on public.jobs
  for each row execute function public.capture_job_location();

-- 4. Backfill: touch every row so the trigger captures the current exact label into
--    job_locations and masks jobs.location in place. Safe/reversible — the exact value
--    is preserved in job_locations before jobs.location is overwritten.
update public.jobs set location = location where location is not null;
