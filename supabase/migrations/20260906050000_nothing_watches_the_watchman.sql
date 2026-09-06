-- ─────────────────────────────────────────────────────────────────────────────
-- Every alert this platform sends leaves the database from inside pg_cron. Nothing
-- outside the database ever checks that pg_cron is still running.
--
-- controls_sweep_and_page (20260814070000:24-95) runs hourly and posts the page;
-- controls_digest (20260812070000) runs daily and posts the digest. Both are scheduled
-- by 20260806030000:107-109 and BOTH net.http_post calls sit inside them. So the entire
-- alerting apparatus — the money controls, the escrow-expiry warning, the safety-report
-- backstop, ctl_alert_not_dispatching itself — is downstream of one scheduler.
--
-- Stop that scheduler and NOTHING happens. Not an error, not a finding, not an email.
-- controls.last_run_at simply freezes, every open finding keeps its old last_seen_at,
-- /controls renders an amber "stale" banner that only exists for whoever opens the page,
-- and the first real signal is a user complaining. That is the 2026-07-10 silence again,
-- one layer up: a trigger sat dead for four weeks and the board stayed green.
--
-- The four ways in, all cheap:
--   · the pg_cron background worker is not running (a restore, a maintenance event,
--     cron.database_name pointing at the wrong database, the extension dropped)
--   · the two cron.job rows are gone — 20260806030000:107 unschedules by jobname before
--     rescheduling, so any future migration that re-runs the unschedule half without the
--     schedule half removes them permanently and silently
--   · a job row is left `active = false`
--   · controls_sweep_and_page throws before it reaches the dispatch at :70-91
--
-- 20260814100000:55-57 named this gap explicitly and deferred it — "catches a dead cron
-- job, not a disarmed flag ... It belongs in its own change, with its own probe." It was
-- never written into OPEN_WORK.md, so the register could not see it either.
--
-- ── WHY THIS CANNOT BE ONE CONTROL ──────────────────────────────────────────
--
-- A control cannot detect that the thing which runs controls has stopped. run_all_controls
-- is called BY the sweep; if the sweep is dead the control never executes, returns nothing,
-- and its finding auto-resolves — exactly the shape that made ctl_alert_dispatch_failing
-- unable to see a dispatch that was never attempted.
--
-- So this is a MUTUAL WATCH, and the outward half deliberately lives outside Postgres:
--
--   1. public.controls_heartbeat()  — the read the outside world makes. One RPC, service
--      role only: how long since the sweep last ran, are both cron.job rows present and
--      active, how many controls are erroring, how many severe findings are open. The
--      Vercel cron in admin/vercel.json calls it and emails through Resend directly —
--      NOT through controls-alert and NOT gated on app_flags.controls_alert, because a
--      watcher that shares a transport with the thing it watches watches nothing.
--
--   2. ctl_heartbeat_absent  — the inward half. The database notices when the external
--      watcher stops checking in. Without it the dead-man's switch is itself unwatched,
--      which is the same failure one turtle further down.
--
--   3. ctl_cron_not_scheduled — the partial case the sweep CAN still see: it is alive, so
--      it can report that controls_digest was unscheduled or a job was flipped inactive.
--      Honest limitation, stated because it is the whole reason (1) exists: if
--      controls_sweep itself is the missing row, this control never runs. It covers the
--      digest and the inactive-flag cases; the heartbeat covers its own.
--
-- ── THE GRACE WINDOW, AND WHY IT EXPIRES ────────────────────────────────────
--
-- ctl_heartbeat_absent would fire the moment this migration lands, because the Vercel
-- cron cannot be deployed by a migration. A control that is red on arrival is a control
-- somebody disables. So the seeded app_flags row carries `grace_until = now() + 7 days`
-- and the first successful call to controls_heartbeat() DELETES that key — the check arms
-- itself the moment the watcher first checks in, and nobody has to remember a second step.
--
-- The window expires rather than waiting to be armed on purpose. If the cron is never
-- wired up, "there is no dead-man's switch" becomes a finding after a week, which is the
-- true statement. A grace window that waited forever would ship a decoration.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Is the scheduler still holding our jobs? ──────────────────────────────
-- Split out from the control so the probe below can discriminate WITHOUT touching real
-- cron state: it asks about a jobname that does not exist and asserts the answer, then
-- asks about the two real ones and asserts silence. Unscheduling a live job to prove a
-- control works would be the worst possible way to test a scheduler.
create or replace function public.cron_schedule_health(p_jobnames text[])
returns table (jobname text, present boolean, active boolean, schedule text, causes text[])
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  total_jobs integer;
begin
  -- Deliberately unguarded. If cron.job cannot be read at all, this raises, run_control
  -- records the control as ERRORING, and an erroring control is alerted exactly as
  -- loudly as a violation — which is the honest answer to "I can no longer tell you".
  -- Swallowing it would report a healthy schedule from a function that cannot see one.
  select count(*) into total_jobs from cron.job;

  return query
  select w.name::text,
         j.jobid is not null,
         coalesce(j.active, false),
         j.schedule::text,
         array_remove(array[
           -- Zero rows visible is ambiguous — an empty cron.job and a cron.job whose RLS
           -- hides every row look identical from here. Named as one cause rather than
           -- asserted as the other, because "your jobs are gone" and "I cannot see your
           -- jobs" want different responses from the person reading it.
           case when j.jobid is null and total_jobs = 0 then 'cron_job_table_empty_or_invisible' end,
           case when j.jobid is null and total_jobs > 0 then 'not_scheduled' end,
           case when j.jobid is not null and not j.active then 'inactive' end
         ]::text[], null)
    from unnest(p_jobnames) as w(name)
    left join cron.job j on j.jobname = w.name;
end;
$$;

revoke execute on function public.cron_schedule_health(text[]) from public, anon, authenticated;
grant  execute on function public.cron_schedule_health(text[]) to service_role;

create or replace function public.ctl_cron_not_scheduled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select h.jobname,
         jsonb_build_object(
           -- Slugs for the same reason ctl_alert_not_dispatching uses them: greppable,
           -- stable across rewording, and a persisting finding keeps one shape.
           'causes', to_jsonb(h.causes),
           'present', h.present,
           'active', h.active,
           'schedule', h.schedule,
           'what_goes_dark', case h.jobname
             when 'controls_sweep' then 'every control, bonus vesting, stale-booking '
                                        'expiry, the assistant purge, the Stripe '
                                        'reconciliation dispatch and the hourly page'
             else 'the daily triage digest — the one email that arrives when nothing is '
                  'newly on fire, and therefore the one whose absence is easiest to miss'
           end,
           'remedy', 'Reschedule it. 20260806030000 is the definition: controls_sweep is '
                     '5 * * * * running select public.controls_sweep_and_page(), '
                     'controls_digest is 5 13 * * * running select public.controls_digest(). '
                     'If cron.job looks empty from here, check that the pg_cron worker is '
                     'running and that cron.database_name names this database.'
         )
    from public.cron_schedule_health(array['controls_sweep', 'controls_digest']) h
   where cardinality(h.causes) > 0
$$;

revoke execute on function public.ctl_cron_not_scheduled() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('cron_not_scheduled',
   'A controls cron job is missing or inactive',
   'high', 'integrity',
   'Both the hourly page and the daily digest are dispatched from inside pg_cron jobs '
   'scheduled by one migration, and that migration unschedules by jobname before it '
   'reschedules — so a future migration re-running the unschedule half alone removes them '
   'silently. Nothing errors: controls.last_run_at simply freezes and the board keeps '
   'rendering the last state it saw. This catches the digest going missing and a job left '
   'inactive. It cannot catch controls_sweep itself dying, because it is run BY that '
   'sweep; the external heartbeat in admin/app/api/controls-heartbeat is the half that can.',
   'ctl_cron_not_scheduled')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── 2. The read the outside world makes ──────────────────────────────────────
-- Seeded before the function so the grace window exists from the first moment the control
-- could run. The note is what somebody standing on /flags sees.
insert into public.app_flags (key, enabled, value, note)
values (
  'controls_heartbeat',
  true,
  jsonb_build_object('grace_until', to_jsonb(now() + interval '7 days')),
  'Check-in record for the EXTERNAL dead-man''s switch (the Vercel cron at '
  'admin/app/api/controls-heartbeat, scheduled in admin/vercel.json). Written by '
  'controls_heartbeat(); read by ctl_heartbeat_absent. grace_until suppresses the control '
  'until the cron is wired up, and the first successful check-in removes it. This row is '
  'not a switch — turning it off changes nothing, because the watcher lives outside this '
  'database on purpose.'
)
on conflict (key) do update set note = excluded.note;

create or replace function public.controls_heartbeat()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  last_run   timestamptz;
  age_min    numeric;
  sched      jsonb;
  broken     text[];
  erroring   integer;
  open_crit  integer;
  open_high  integer;
  -- Appends below are cast ::text on purpose. `text[] || 'literal'` is ambiguous
  -- and Postgres resolves it to array||array, which fails at runtime with
  -- "malformed array literal" — i.e. exactly when a reason first had to be
  -- recorded, which is the moment this watcher exists for.
  reasons    text[] := '{}';
  verdict    text;
begin
  -- The external half's real question: has the sweep run recently? Taken from the
  -- REGISTRY rather than from cron, because it is the fact that matters — a job row that
  -- exists and never fires is the same outage as a job row that is gone.
  select max(last_run_at) into last_run
    from public.controls where enabled and not external;
  age_min := case when last_run is null then null
                  else round(extract(epoch from (now() - last_run)) / 60.0, 1) end;

  select coalesce(jsonb_agg(to_jsonb(h) order by h.jobname), '[]'::jsonb),
         coalesce(array_agg(h.jobname) filter (where cardinality(h.causes) > 0), '{}'::text[])
    into sched, broken
    from public.cron_schedule_health(array['controls_sweep', 'controls_digest']) h;

  select count(*) filter (where enabled and last_error is not null) into erroring
    from public.controls;

  select count(*) filter (where severity = 'critical'),
         count(*) filter (where severity = 'high')
    into open_crit, open_high
    from public.control_findings where resolved_at is null;

  if cardinality(broken) > 0            then reasons := reasons || 'scheduler'::text; end if;
  -- Three missed hourly sweeps. controls-alert already calls a control stale at 6h; this
  -- is the harder failure (nothing ran at all rather than one check going quiet) and it
  -- is being watched from outside, so it does not have to wait as long.
  if last_run is null or age_min > 180  then reasons := reasons || 'sweep_stale'::text; end if;
  if erroring > 0                       then reasons := reasons || 'controls_erroring'::text; end if;
  verdict := case when cardinality(reasons) = 0 then 'ok' else 'alert' end;

  -- Record the check-in. This is the INWARD half of the mutual watch, and removing
  -- grace_until here is what arms ctl_heartbeat_absent: wiring the cron up is what turns
  -- the check on, so there is no second step for anyone to forget.
  --
  -- Written on every call regardless of verdict — the watcher being alive is a different
  -- fact from the thing it watches being healthy, and conflating them would make a bad
  -- verdict look like a dead watcher.
  insert into public.app_flags (key, value)
  values ('controls_heartbeat',
          jsonb_build_object('last_seen_at', to_jsonb(now()), 'last_verdict', verdict))
  on conflict (key) do update
     set value = (public.app_flags.value - 'grace_until')
                 || jsonb_build_object('last_seen_at', to_jsonb(now()),
                                       'last_verdict', verdict),
         updated_at = now();

  return jsonb_build_object(
    'at',                        to_jsonb(now()),
    'verdict',                   verdict,
    'reasons',                   to_jsonb(reasons),
    'sweep_last_run_at',         to_jsonb(last_run),
    'sweep_age_minutes',         age_min,
    'sweep_stale_after_minutes', 180,
    'scheduler',                 sched,
    'scheduler_broken',          to_jsonb(broken),
    'controls_erroring',         erroring,
    'open_critical',             open_crit,
    'open_high',                 open_high);
end;
$$;

revoke execute on function public.controls_heartbeat() from public, anon, authenticated;
grant  execute on function public.controls_heartbeat() to service_role;

-- ── 3. And the database watches the watcher ──────────────────────────────────
create or replace function public.ctl_heartbeat_absent()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  -- Scalar subqueries rather than a join, so this returns exactly one row whether the
  -- config row exists or not. A missing row must be REPORTED, not silently skipped —
  -- deleting it is one of the ways the watcher goes quiet.
  with s as (
    select exists (select 1 from public.app_flags where key = 'controls_heartbeat')
             as present,
           (select (value->>'last_seen_at')::timestamptz from public.app_flags
             where key = 'controls_heartbeat') as last_seen,
           (select (value->>'grace_until')::timestamptz from public.app_flags
             where key = 'controls_heartbeat') as grace_until,
           (select value->>'last_verdict' from public.app_flags
             where key = 'controls_heartbeat') as last_verdict
  )
  -- One row per channel, and there is exactly one channel — so entity_id is a constant.
  -- Cast explicitly: an unknown-typed literal in the first column of a RETURNS TABLE is
  -- the kind of thing that resolves fine until it does not.
  select 'controls_heartbeat'::text,
         jsonb_build_object(
           'causes', to_jsonb(array_remove(array[
             case when not s.present            then 'config_row_deleted' end,
             case when s.last_seen is null      then 'never_checked_in' end,
             case when s.last_seen is not null  then 'stopped_checking_in' end
           ]::text[], null)),
           'last_seen_at', to_jsonb(s.last_seen),
           'hours_since_check_in', case when s.last_seen is null then null
             else round(extract(epoch from (now() - s.last_seen)) / 3600.0, 1) end,
           'last_verdict', s.last_verdict,
           'what_goes_dark', 'the only check on pg_cron itself. Every alert this platform '
                             'sends is dispatched from inside controls_sweep_and_page or '
                             'controls_digest, both scheduled by pg_cron — so if the '
                             'scheduler stops, no control runs, no finding is written and '
                             'no email is sent. This finding is being written, so the '
                             'sweep is alive right now; what has stopped is the thing '
                             'that would tell you when it is not.',
           'remedy', 'The watcher is the Vercel cron in admin/vercel.json calling '
                     '/api/controls-heartbeat. Check that the admin project deployed (it '
                     'does NOT auto-deploy: cd admin && npx vercel --prod --scope '
                     'go-hustlr), that CRON_SECRET is set on that project, and that the '
                     'cron shows recent invocations. A 401 there looks like success from '
                     'the Vercel side and is silent from this one.'
         )
    from s
   -- Quiet until the cron has had a week to be wired up, and quiet forever after that as
   -- long as it keeps checking in. Six hours is deliberately looser than the heartbeat's
   -- own hourly cadence: a single missed invocation is not an outage.
   where (s.grace_until is null or s.grace_until <= now())
     and (s.last_seen is null or s.last_seen < now() - interval '6 hours')
$$;

revoke execute on function public.ctl_heartbeat_absent() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('heartbeat_absent',
   'The external dead-man''s switch has stopped checking in',
   'high', 'integrity',
   'A control cannot detect that the thing which runs controls has stopped — it is run by '
   'that thing. So the dead-man''s switch lives outside Postgres, as a Vercel cron that '
   'reads controls_heartbeat() and emails through its own transport. That watcher is then '
   'itself unwatched unless something in here notices it going quiet, which is this row. '
   'When this fires the sweep is demonstrably alive (it just ran this control); what has '
   'been lost is the ability to find out when it is not.',
   'ctl_heartbeat_absent')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Prove all three discriminate, without touching a live cron job, rolled back ─
do $$
declare
  n int; hb jsonb; c text[]; sched_ok int; named boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- (a) The two real jobs are visible AND healthy through the exact SECURITY DEFINER path
  -- the control uses. This is not decoration: if cron.job's RLS hid them from the function
  -- owner, the control would report both as missing on its very first run and the fix
  -- would be worse than the gap. A failure here on apply is a true finding — the jobs
  -- really are not scheduled — and the push should stop.
  select count(*) into sched_ok
    from public.cron_schedule_health(array['controls_sweep', 'controls_digest']) h
   where cardinality(h.causes) = 0;
  if sched_ok <> 2 then
    raise exception 'controls_sweep/controls_digest are not both healthily scheduled (% of 2 clean) — either pg_cron is not holding them or this function cannot see them', sched_ok;
  end if;
  raise notice 'both cron jobs are visible and healthy through the definer path the control uses';

  -- (b) It discriminates. A jobname that was never scheduled is reported, and reported as
  -- the right cause — asked about a name that does not exist rather than by unscheduling
  -- a real one, because breaking the scheduler to test the scheduler test is not a test.
  select h.causes into c
    from public.cron_schedule_health(array['controls_sweep_probe_absent']) h;
  if c is null or not ('not_scheduled' = any (c)) then
    raise exception 'FIX FAILED: an unscheduled job was reported as %, not not_scheduled', c;
  end if;
  raise notice 'discriminates: an unscheduled jobname is reported as not_scheduled';

  select count(*) into n from public.ctl_cron_not_scheduled();
  if n <> 0 then
    raise exception 'ctl_cron_not_scheduled fired on a healthy schedule (% rows) — permanent noise', n;
  end if;
  raise notice 'silent on the live schedule, so it does not arrive red';

  -- (c) The heartbeat reads what the outside world needs and says ok when the sweep is
  -- fresh. Staged, because on a database whose sweep has not run in hours the healthy
  -- branch would otherwise be untestable.
  update public.controls set last_run_at = now() where enabled and not external;
  update public.controls set last_error = null where last_error is not null;
  hb := public.controls_heartbeat();
  if hb->>'verdict' <> 'ok' then
    raise exception 'heartbeat called a freshly-swept, cleanly-scheduled system %: %', hb->>'verdict', hb->'reasons';
  end if;
  raise notice 'heartbeat reports ok on a fresh sweep, so the pager stays quiet when it should';

  -- (d) And it catches the outage it exists for. Nine hours is three missed sweeps past
  -- the threshold — the state a dead pg_cron worker produces within a morning.
  update public.controls set last_run_at = now() - interval '9 hours' where enabled and not external;
  hb := public.controls_heartbeat();
  if hb->>'verdict' <> 'alert' or not (hb->'reasons' ? 'sweep_stale') then
    raise exception 'FIX FAILED: a 9-hour-old sweep was reported as % / %', hb->>'verdict', hb->'reasons';
  end if;
  raise notice 'discriminates: a 9-hour-old sweep is an alert, which is the outage nothing could see before';

  -- (e) The inward half. Within the grace window, silent — a control that is red the day
  -- it ships is a control somebody disables.
  update public.app_flags
     set value = jsonb_build_object('grace_until', to_jsonb(now() + interval '7 days'))
   where key = 'controls_heartbeat';
  select count(*) into n from public.ctl_heartbeat_absent();
  if n <> 0 then
    raise exception 'heartbeat_absent fired inside its grace window (% rows) — it would arrive red', n;
  end if;
  raise notice 'silent inside the grace window';

  -- (f) Grace expired and the watcher never once checked in: that is the finding.
  update public.app_flags
     set value = jsonb_build_object('grace_until', to_jsonb(now() - interval '1 hour'))
   where key = 'controls_heartbeat';
  select count(*) into n from public.ctl_heartbeat_absent();
  if n <> 1 then
    raise exception 'FIX FAILED: an unwired heartbeat past its grace window reported % rows', n;
  end if;
  select (f.detail->'causes') ? 'never_checked_in' into named
    from public.ctl_heartbeat_absent() f limit 1;
  if not coalesce(named, false) then
    raise exception 'FIX FAILED: the finding does not name never_checked_in as the cause';
  end if;
  raise notice 'discriminates: a heartbeat that never arrived is reported once its window expires, and named as such';

  -- (g) A check-in arms it and silences it in one step — no second manual action exists
  -- to be forgotten.
  hb := public.controls_heartbeat();
  select count(*) into n from public.ctl_heartbeat_absent();
  if n <> 0 then
    raise exception 'still firing after a successful check-in (% rows) — this could never auto-resolve', n;
  end if;
  if exists (select 1 from public.app_flags
              where key = 'controls_heartbeat' and value ? 'grace_until') then
    raise exception 'the check-in did not clear grace_until — the control would stay disarmed forever';
  end if;
  raise notice 'a check-in arms the control and closes the finding, so it resolves rather than accumulating';

  -- (h) And it notices the watcher going quiet afterwards.
  update public.app_flags
     set value = value || jsonb_build_object('last_seen_at', to_jsonb(now() - interval '9 hours'))
   where key = 'controls_heartbeat';
  select count(*) into n from public.ctl_heartbeat_absent();
  if n <> 1 then
    raise exception 'FIX FAILED: a watcher silent for 9 hours reported % rows', n;
  end if;
  raise notice 'discriminates: a watcher that stops checking in is reported';

  -- (i) Both registered, or run_all_controls never reaches either and the board stays green.
  select count(*) into n from public.controls
   where key in ('cron_not_scheduled', 'heartbeat_absent') and enabled and not external;
  if n <> 2 then
    raise exception 'only % of 2 new controls are in the roster run_all_controls iterates', n;
  end if;
  raise notice 'both registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'dead-man''s switch probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
