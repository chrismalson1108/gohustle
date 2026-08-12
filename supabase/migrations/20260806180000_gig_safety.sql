-- ─────────────────────────────────────────────────────────────────────────────
-- In-person safety: share-my-gig, overdue check-ins, emergency (2026-08-06).
--
-- This product sends college students to strangers' homes, and until now the entire
-- safety surface was a `reports` table — which files AFTER something has happened. Every
-- other risk in this system costs money; this one does not, and it is the only category
-- where the downside is unbounded and irreversible.
--
-- THREE MECHANISMS, DELIBERATELY SIMPLE
--
--   SHARE      the earner sends a link to a friend or parent: where they are, who with,
--              when they are due back, and whether they have checked out. No account
--              needed at the other end — the person you want watching is usually not a
--              user, and requiring a signup is how a safety feature goes unused.
--
--   CHECK-IN   a gig that started and never finished is the signal. The system knows
--              when work began (bookings.started_at) and roughly how long it should
--              take (jobs.estimated_hours), so it can notice. First a gentle nudge to
--              the earner, and only if that goes unanswered does it escalate — because
--              the overwhelming majority of overdue gigs are somebody who forgot to tap
--              a button, and a system that cries wolf on those is a system nobody reads.
--
--   EMERGENCY  one button that files a report with source='emergency', which the
--              existing trg_notify_safety_report already routes to a human.
--
-- WHAT THE SHARE LINK DELIBERATELY DOES AND DOES NOT EXPOSE
--
-- It DOES show the exact address. That is the entire point — "I know where you are" is
-- the thing that makes someone safer, and a masked location helps nobody in an
-- emergency. It shows first names only, the job title, when work started, when it is
-- due to end, and the current status.
--
-- It does NOT show: surnames, phone numbers, email addresses, avatars, the poster's
-- profile, the conversation, the pay, or any id that could be used to look someone up
-- elsewhere in the product. A share link is a safety artefact, not a window into an
-- account.
--
-- The address disclosure is the one genuine trade-off here: a poster listing a gig at
-- their home has that address shown to a third party the earner chooses. That is the
-- right call — a worker's physical safety outranks an address that the worker already
-- knows and is standing at — but it needs to be stated in the Terms, which is flagged
-- below rather than quietly assumed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Share links ──────────────────────────────────────────────────────────────
create table if not exists public.gig_shares (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  -- 32 chars of URL-safe randomness. Long enough that enumeration is hopeless, which
  -- matters because this is the one table anon can read through.
  token       text not null unique,
  label       text,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  view_count  integer not null default 0,
  last_viewed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists gig_shares_booking_idx on public.gig_shares (booking_id);
create index if not exists gig_shares_token_live_idx
  on public.gig_shares (token) where revoked_at is null;

alter table public.gig_shares enable row level security;
revoke all on public.gig_shares from anon, authenticated;
grant all on public.gig_shares to service_role;
-- The earner manages their own links. Reading happens through the token RPC, never
-- through the table, so anon gets nothing here.
grant select, insert, update on public.gig_shares to authenticated;

drop policy if exists gig_shares_own on public.gig_shares;
create policy gig_shares_own on public.gig_shares
  for select using (auth.uid() = created_by);

drop policy if exists gig_shares_insert_own on public.gig_shares;
create policy gig_shares_insert_own on public.gig_shares
  for insert with check (
    auth.uid() = created_by
    -- Only for a booking you are actually on. Sharing someone else's gig would be a
    -- location leak dressed up as a safety feature.
    and exists (select 1 from public.bookings b where b.id = booking_id and b.earner_id = auth.uid())
  );

drop policy if exists gig_shares_revoke_own on public.gig_shares;
create policy gig_shares_revoke_own on public.gig_shares
  for update using (auth.uid() = created_by) with check (auth.uid() = created_by);

-- ── The public read ──────────────────────────────────────────────────────────
-- SECURITY DEFINER and token-gated. The projection below is the whole privacy design:
-- everything a worried friend needs, nothing that identifies anyone beyond a first
-- name. Returns null for a bad, revoked or expired token — indistinguishable from each
-- other on purpose, so this cannot be used to probe which tokens exist.
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
    split_part(coalesce(pe.name, 'Someone'), ' ', 1)  as earner_first,
    split_part(coalesce(pp.name, 'the poster'), ' ', 1) as poster_first,
    j.title, j.location, j.lat, j.lng, j.estimated_hours,
    b.status, b.started_at, b.starts_at, b.completed_at
  into r
  from public.bookings b
  join public.jobs j       on j.id = b.job_id
  left join public.profiles pe on pe.id = b.earner_id
  left join public.profiles pp on pp.id = j.poster_id
  where b.id = sh.booking_id;
  if not found then return null; end if;

  update public.gig_shares
     set view_count = view_count + 1, last_viewed_at = now()
   where id = sh.id;

  return jsonb_build_object(
    'earner_first', r.earner_first,
    'poster_first', r.poster_first,
    'job_title', r.title,
    -- Exact, on purpose. A masked location helps nobody at 11pm.
    'location', r.location,
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
-- anon CAN call this: the person watching out for a student is usually not a user, and
-- making them sign up is how a safety feature goes unused. The token is the credential.
grant execute on function public.view_gig_share(text) to anon, authenticated, service_role;

-- ── Overdue check-ins ────────────────────────────────────────────────────────
-- A gig that started and never finished is the signal. Two stages on purpose: most
-- overdue gigs are somebody who forgot to tap done, and escalating those immediately
-- trains everyone to ignore the alert that matters.
create table if not exists public.safety_checkins (
  booking_id    uuid primary key references public.bookings(id) on delete cascade,
  due_at        timestamptz not null,
  nudged_at     timestamptz,
  escalated_at  timestamptz,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists safety_checkins_open_idx
  on public.safety_checkins (due_at) where resolved_at is null;

alter table public.safety_checkins enable row level security;
revoke all on public.safety_checkins from anon, authenticated;
grant all on public.safety_checkins to service_role;

-- Open a check-in when work starts. AFTER UPDATE so it cannot block startJob.
create or replace function public.open_safety_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hrs numeric;
begin
  if new.started_at is null or old.started_at is not null then
    return new;
  end if;
  select coalesce(estimated_hours, 2) into hrs from public.jobs where id = new.job_id;
  insert into public.safety_checkins (booking_id, due_at)
  values (new.id, new.started_at + (coalesce(hrs, 2) * interval '1 hour') + interval '45 minutes')
  on conflict (booking_id) do update set due_at = excluded.due_at, resolved_at = null;
  return new;
exception when others then
  -- Never let a safety bookkeeping failure stop someone starting work.
  raise warning 'safety checkin open failed for booking %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke execute on function public.open_safety_checkin() from public, anon, authenticated;

drop trigger if exists trg_z_open_safety_checkin on public.bookings;
create trigger trg_z_open_safety_checkin
  after update of started_at on public.bookings
  for each row execute function public.open_safety_checkin();

-- Close it as soon as the work is done, by either party.
create or replace function public.close_safety_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'verified', 'cancelled', 'declined') then
    update public.safety_checkins
       set resolved_at = now()
     where booking_id = new.id and resolved_at is null;
  end if;
  return new;
exception when others then
  raise warning 'safety checkin close failed for booking %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke execute on function public.close_safety_checkin() from public, anon, authenticated;

drop trigger if exists trg_z_close_safety_checkin on public.bookings;
create trigger trg_z_close_safety_checkin
  after update of status on public.bookings
  for each row execute function public.close_safety_checkin();

-- ── The control that notices ─────────────────────────────────────────────────
-- Overdue past the nudge window AND still unresolved. Severity critical: this is a
-- person who started work hours ago and has not been heard from.
create or replace function public.ctl_safety_checkin_overdue()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.booking_id::text,
         jsonb_build_object(
           'earner_id', b.earner_id,
           'poster_id', j.poster_id,
           'job_title', j.title,
           'location', j.location,
           'started_at', b.started_at,
           'due_at', c.due_at,
           'hours_overdue', round(extract(epoch from now() - c.due_at) / 3600.0, 1),
           'nudged', c.nudged_at is not null,
           'booking_status', b.status)
    from public.safety_checkins c
    join public.bookings b on b.id = c.booking_id
    join public.jobs j     on j.id = b.job_id
   where c.resolved_at is null
     and c.due_at < now()
     and b.status not in ('completed', 'verified', 'cancelled', 'declined')
$$;

revoke execute on function public.ctl_safety_checkin_overdue() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('safety_checkin_overdue',
   'A worker started a gig and has not checked out',
   'critical', 'security',
   'bookings.started_at is set and the booking never reached completed, past the '
   'expected end plus a 45-minute grace. Usually someone who forgot to tap done — which '
   'is exactly why the app nudges first and this only fires on the ones that stay '
   'silent. The one control here where the subject is a person rather than money.',
   'ctl_safety_checkin_overdue')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Emergency ────────────────────────────────────────────────────────────────
-- Routes through the EXISTING reports path, which trg_notify_safety_report already
-- escalates to a human. Reusing it means the emergency button inherits an alerting
-- chain that has been tested, rather than inventing a second one that has not.
create or replace function public.raise_gig_emergency(p_booking uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  b   record;
  rid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select bk.id, bk.earner_id, bk.job_id, j.poster_id
    into b
    from public.bookings bk join public.jobs j on j.id = bk.job_id
   where bk.id = p_booking and (bk.earner_id = uid or j.poster_id = uid);
  if not found then raise exception 'not your booking'; end if;

  -- guard_reports_write pins source := 'user' for every non-service_role caller, and
  -- SECURITY DEFINER changes the EXECUTING USER, not the JWT claims — so auth.role() in
  -- here is still 'authenticated' and the pin would fire. Without this the emergency
  -- lands in the queue indistinguishable from a routine report, which defeats the
  -- entire button. app.emergency is the same transaction-local escape hatch the repo
  -- already uses for app.recompute, and the guard below honours it.
  perform set_config('app.emergency', 'on', true);

  -- source='emergency' is what distinguishes this in the moderation queue from an
  -- ordinary report, and what the alert email leads with.
  insert into public.reports (reporter_id, reported_user_id, job_id, booking_id, reason, details, source)
  values (uid,
          case when uid = b.earner_id then b.poster_id else b.earner_id end,
          b.job_id, b.id, 'emergency',
          coalesce(nullif(btrim(p_note), ''), 'Emergency raised from an active gig.'),
          'emergency')
  returning id into rid;

  return rid;
end;
$$;

revoke execute on function public.raise_gig_emergency(uuid, text) from public, anon;
grant execute on function public.raise_gig_emergency(uuid, text) to authenticated, service_role;

-- NOTE FOR THE TERMS: a share link discloses the gig's exact address to whoever holds
-- it. That is deliberate and correct — a worker's physical safety outranks an address
-- the worker is already standing at — but posters should be told it can happen. Add to
-- the Privacy/Terms drafts before the beta opens.

-- Teach guard_reports_write about the escape hatch. Reproduced from the live definition
-- with ONLY the source pin changed; every other pin (resolution columns, the UPDATE
-- branch) is preserved exactly.
create or replace function public.guard_reports_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- 'emergency' is settable only from inside raise_gig_emergency, which sets this
  -- transaction-local GUC immediately before inserting. A client cannot set it: GUCs
  -- are not reachable over PostgREST, and the value dies with the transaction.
  if coalesce(current_setting('app.emergency', true), '') = 'on'
     and new.source = 'emergency' then
    null;  -- leave source alone
  else
    new.source := 'user';
  end if;

  if tg_op = 'INSERT' then
    new.resolved_at  := null;
    new.resolved_by  := null;
    new.resolution   := null;
  else
    new.resolved_at  := old.resolved_at;
    new.resolved_by  := old.resolved_by;
    new.resolution   := old.resolution;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_reports_write() from public, anon, authenticated;
