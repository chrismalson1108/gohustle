-- ─────────────────────────────────────────────────────────────────────────────
-- Two safety defects found by the adversarial audit, both in 20260806180000.
--
-- ── 1. THE SHARE LINK NEVER SHOWED THE EXACT ADDRESS ────────────────────────
--
-- trg_mask_job_location (20260722040000) rewrites jobs.location to the city form and
-- rounds lat/lng to 2 decimals AT WRITE TIME; the precise string lives in
-- job_locations, which view_gig_share never joined. Demonstrated live: a job set to
-- '4212 Legacy Drive, Plano, TX 75024' came back through the share page as
-- {"location":"Plano","lat":33.08,"lng":-96.81}.
--
-- So the feature's stated premise — "a masked location helps nobody in an emergency" —
-- was false in production, and the Terms and Privacy published in 20260806190000 now
-- assert an address disclosure that does not happen.
--
-- THE OBVIOUS FIX IS A SECURITY HOLE. Simply joining job_locations inside a SECURITY
-- DEFINER function bypasses job_locations_party_read, which deliberately requires the
-- booking to be confirmed/completed/verified (mirroring canSeeExactAddress in
-- src/lib/address.js). Since gig_shares_insert_own has NO status check, any earner
-- could apply to a gig, mint a share on their own PENDING booking, open their own share
-- page, and read a poster's exact street address they are not entitled to. That hands a
-- full bypass of 20260722040000 to anyone who taps Apply.
--
-- So both halves move together: the projection gates on booking status, AND the insert
-- policy refuses to mint a link for a booking that has not been accepted.
--
-- COORDINATES ARE NOT FIXED, DELIBERATELY. There are no precise coordinates to recover:
-- LocationPicker yields NULL coords for a free-typed street address and a CITY CENTROID
-- for a selected suggestion, so persisting the pre-round value would store a centroid at
-- six decimals — a pin that looks authoritative and can be tens of km out. Worse than a
-- coarse pin. Instead the page links to the exact address STRING, which Google resolves
-- to the building, and the coarse pin is labelled as approximate when that is all we
-- have.
--
-- ── 2. THE SOS BUTTON WAS THROTTLED BY THE SPAM QUOTA ───────────────────────
--
-- raise_gig_emergency inserts into reports, which carries trg_guard_report_rate_limit:
-- 10 user-filed reports per hour. An emergency is not a report, and a limiter designed
-- to stop report spam must never be the reason someone in danger cannot raise an alarm.
-- The guard already exempts source='auto' for exactly this class of reasoning; this
-- extends that to source='emergency', which only raise_gig_emergency can set (it is
-- gated behind the app.emergency GUC that a client cannot reach).
--
-- Emergencies are still bounded — see ctl_emergency_flood below — but by ALERTING a
-- human rather than by silently refusing the person pressing the button.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1a. Only an accepted booking may mint a share link ──────────────────────
drop policy if exists gig_shares_insert_own on public.gig_shares;
create policy gig_shares_insert_own on public.gig_shares
  for insert with check (
    auth.uid() = created_by
    and exists (
      select 1 from public.bookings b
       where b.id = booking_id
         and b.earner_id = auth.uid()
         -- Same statuses job_locations_party_read requires. Without this, minting a
         -- link on a PENDING booking would read out an address the earner cannot
         -- otherwise see.
         and b.status in ('confirmed', 'completed', 'verified')
    )
  );

-- ── 1b. Project the exact address, gated identically ────────────────────────
create or replace function public.view_gig_share(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sh public.gig_shares%rowtype;
  r  record;
begin
  if p_token is null or length(p_token) < 16 then return null; end if;

  select * into sh from public.gig_shares
   where token = p_token and revoked_at is null and expires_at > now();
  if not found then return null; end if;

  select
    split_part(coalesce(pe.name, 'Someone'), ' ', 1)    as earner_first,
    split_part(coalesce(pp.name, 'the poster'), ' ', 1) as poster_first,
    j.title, j.location, j.lat, j.lng, j.estimated_hours,
    b.status, b.started_at, b.starts_at, b.completed_at,
    -- The exact label, but ONLY once the booking is accepted — the same condition
    -- job_locations_party_read enforces for the earner themselves. A SECURITY DEFINER
    -- function that ignored it would be a way to read addresses off unaccepted
    -- applications.
    case when b.status in ('confirmed', 'completed', 'verified')
         then jl.exact_location else null end          as exact_location
  into r
  from public.bookings b
  join public.jobs j            on j.id = b.job_id
  left join public.job_locations jl on jl.job_id = j.id
  left join public.profiles pe  on pe.id = b.earner_id
  left join public.profiles pp  on pp.id = j.poster_id
  where b.id = sh.booking_id;
  if not found then return null; end if;

  update public.gig_shares
     set view_count = view_count + 1, last_viewed_at = now()
   where id = sh.id;

  return jsonb_build_object(
    'earner_first', r.earner_first,
    'poster_first', r.poster_first,
    'job_title', r.title,
    -- Exact when we have it, city-level otherwise.
    'location', coalesce(nullif(btrim(coalesce(r.exact_location, '')), ''), r.location),
    -- Tells the page whether to present the location as a precise address or as an
    -- approximate area. Rendering a city centroid under a confident "Where" heading is
    -- the failure this whole finding was about.
    'location_is_exact', (nullif(btrim(coalesce(r.exact_location, '')), '') is not null),
    'lat', r.lat,
    'lng', r.lng,
    'status', r.status,
    'started_at', r.started_at,
    'scheduled_at', r.starts_at,
    'expected_end', case
      when r.started_at is not null
        then r.started_at + (coalesce(r.estimated_hours, 2) * interval '1 hour')
      else null end,
    'completed_at', r.completed_at,
    'is_done', r.status in ('completed', 'verified'),
    'expires_at', sh.expires_at,
    'label', sh.label
  );
end;
$$;

revoke execute on function public.view_gig_share(text) from public;
grant execute on function public.view_gig_share(text) to anon, authenticated, service_role;

-- ── 2. An emergency is never throttled ──────────────────────────────────────
-- Reproduced from the LIVE definition with one predicate added; the auto-exemption and
-- the limit itself are unchanged.
create or replace function public.guard_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count int;
  report_limit_per_hour constant int := 10;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- An emergency is not a report. A limiter built to stop report spam must never be
  -- the reason someone in danger cannot raise an alarm. Only raise_gig_emergency can
  -- set source='emergency' — guard_reports_write pins everything else to 'user' unless
  -- the app.emergency GUC is set, and a client cannot reach a GUC.
  if new.source = 'emergency' then
    return new;
  end if;

  select count(*) into recent_count
  from public.reports r
  where r.reporter_id = auth.uid()
    and coalesce(r.source, 'user') <> 'auto'
    and r.created_at > now() - interval '1 hour';

  if recent_count >= report_limit_per_hour then
    raise exception
      'You have filed several reports in a short time. If someone is in danger, contact support or emergency services directly.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_report_rate_limit() from public, anon, authenticated;

-- Emergencies are bounded by ALERTING rather than by refusing. Someone pressing SOS
-- repeatedly is either in real trouble or abusing it, and both need a human — neither
-- is served by a silent rejection.
create or replace function public.ctl_emergency_flood()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.reporter_id::text,
         jsonb_build_object(
           'emergencies_1h', count(*),
           'latest', max(r.created_at),
           'bookings', array_agg(distinct r.booking_id))
    from public.reports r
   where r.source = 'emergency'
     and r.created_at > now() - interval '1 hour'
   group by r.reporter_id
  having count(*) >= 3
$$;

revoke execute on function public.ctl_emergency_flood() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('emergency_flood',
   'One user raised three or more emergencies in an hour',
   'high', 'security',
   'The SOS path is deliberately exempt from the report rate limiter — a spam control '
   'must never stop someone in danger. This is the replacement bound: repeated '
   'emergencies are surfaced to a human instead of silently refused, because the person '
   'pressing it is either in real trouble or abusing it and both need attention.',
   'ctl_emergency_flood')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
