-- ─────────────────────────────────────────────────────────────────────────────
-- Control framework: scheduled invariant checks with findings + alerting (2026-08-06).
--
-- WHY THIS EXISTS, AND WHY IT IS NOT IN THE ADMIN CONSOLE
--
-- The console is a CLIENT of this database. A check that lives in a Next.js route
-- only runs when a human opens a page — so it does not run at 3am, it does not run
-- on a Sunday, and it does not run at all while the console is broken or Vercel is
-- having a bad day. That is a report, not a control. Controls run in Postgres on a
-- schedule and push their findings outward; the console reads and actions them.
--
-- THE MODEL
--
--   controls           registry: one row per check, with severity and an on/off switch
--   ctl_<key>()        the check itself — a SET-RETURNING function, defined in a
--                      migration, reviewed in git, containing NO dynamic SQL
--   control_findings   one row per (control, violating entity), with open/resolved
--                      state; NOT append-only, because a finding's whole life cycle
--                      is "appeared, was investigated, went away"
--   run_all_controls() the runner, invoked by pg_cron
--
-- Controls are FUNCTIONS, not SQL text in a table. Storing executable SQL in a row
-- an operator can edit would hand anyone with console write access arbitrary
-- SECURITY DEFINER execution — the exact privilege-escalation shape this system
-- exists to detect. The registry names a function; it never carries its body.
-- run_control() additionally refuses any name outside ^ctl_[a-z0-9_]+$ and verifies
-- the function exists in pg_proc before it will execute it.
--
-- A control returns ONE ROW PER VIOLATION as (entity_id text, detail jsonb), and
-- returns ZERO rows on a healthy system. "No rows" is the passing state, which makes
-- a broken control (one that errors) loudly different from a passing one: errors are
-- recorded on the registry row and alerted, never silently treated as clean.
--
-- FAIL LOUD, NOT SILENT. If a control throws, the runner catches it, records the
-- error against that control, and CARRIES ON with the rest — one bad check must not
-- take down the whole sweep — but the error is itself an alertable condition. A
-- monitoring system that quietly stops monitoring is worse than none, because it
-- manufactures confidence.
--
-- This migration ships the framework and ZERO controls, so it is a pure no-op on
-- application behaviour. Controls arrive in a following migration and can be enabled
-- one at a time.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Registry ─────────────────────────────────────────────────────────────────
create table if not exists public.controls (
  key              text primary key,
  title            text not null,
  severity         text not null check (severity in ('critical','high','medium','low')),
  domain           text not null check (domain in ('money','lifecycle','integrity','security','abuse')),
  why              text,
  fn_name          text not null,
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  last_run_ms      integer,
  last_violations  integer,
  last_error       text,
  created_at       timestamptz not null default now()
);

comment on table public.controls is
  'Registry of scheduled invariant checks. fn_name names a ctl_* set-returning '
  'function defined in a migration; the SQL body is never stored here.';

-- ── Findings ─────────────────────────────────────────────────────────────────
-- Unique on (control_key, entity_id): a violation that persists across runs stays
-- ONE finding with a moving last_seen_at, rather than accumulating a row per sweep.
-- Without this an hourly control on a stuck payment writes 168 identical rows a week
-- and the queue becomes unreadable — which is how alert fatigue starts.
create table if not exists public.control_findings (
  id             bigint generated always as identity primary key,
  control_key    text not null references public.controls(key) on delete cascade,
  entity_id      text not null default '',
  severity       text not null,
  detail         jsonb not null default '{}'::jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    uuid references auth.users(id),
  note           text
);

create unique index if not exists control_findings_open_uniq
  on public.control_findings (control_key, entity_id) where resolved_at is null;
create index if not exists control_findings_open_idx
  on public.control_findings (severity, last_seen_at desc) where resolved_at is null;

-- ── Lockdown ─────────────────────────────────────────────────────────────────
-- Same posture as app_flags / admin_audit_log: RLS on with NO policies and grants
-- revoked, so both tables are invisible and inert to anon and authenticated. Only
-- the service role (the console) reads them. Findings name internal state and
-- user ids; they are not user-facing.
alter table public.controls         enable row level security;
alter table public.control_findings enable row level security;
revoke all on public.controls         from anon, authenticated;
revoke all on public.control_findings from anon, authenticated;
grant all  on public.controls         to service_role;
grant all  on public.control_findings to service_role;

-- ── Runner: one control ──────────────────────────────────────────────────────
create or replace function public.run_control(p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c            public.controls%rowtype;
  started      timestamptz := clock_timestamp();
  n            integer := 0;
  seen         text[]  := '{}';
begin
  select * into c from public.controls where key = p_key;
  if not found then
    raise exception 'unknown control %', p_key using errcode = 'no_data_found';
  end if;
  if not c.enabled then
    return 0;
  end if;

  -- The function name comes from a table only service_role can write, but it is
  -- still interpolated into executable SQL, so it is validated twice: shape first,
  -- then existence. %I quoting alone is not a substitute for knowing what you are
  -- about to run.
  if c.fn_name !~ '^ctl_[a-z0-9_]+$' then
    raise exception 'control % has an illegal fn_name %', p_key, c.fn_name
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = c.fn_name
  ) then
    raise exception 'control % names a function that does not exist: %', p_key, c.fn_name
      using errcode = 'undefined_function';
  end if;

  -- Upsert every current violation AND collect the ids seen, in ONE pass.
  --
  -- The control function is invoked exactly once. Calling it twice — once to write
  -- findings and again to decide what to auto-resolve — would let the underlying
  -- data change between the two reads, so a violation that appeared in the first
  -- call and not the second would be recorded and instantly auto-resolved in the
  -- same run. `v` is MATERIALIZED to pin that: it is referenced twice below, and an
  -- inlined CTE would re-evaluate it. The data-modifying CTE runs regardless of
  -- whether the final select references it.
  execute format($f$
    with v as materialized (
      select coalesce(entity_id, '') as entity_id,
             coalesce(detail, '{}'::jsonb) as detail
        from public.%I()
    ), up as (
      insert into public.control_findings (control_key, entity_id, severity, detail)
      select %L, v.entity_id, %L, v.detail from v
      on conflict (control_key, entity_id) where resolved_at is null
      do update set last_seen_at = now(), detail = excluded.detail
    )
    select coalesce(array_agg(entity_id), '{}'::text[]) from v
  $f$, c.fn_name, p_key, c.severity)
  into seen;

  n := coalesce(array_length(seen, 1), 0);

  -- Auto-resolve: a finding the control no longer returns has stopped being true.
  -- Recording that automatically is what keeps the queue honest — a stale open
  -- finding trains you to ignore the queue.
  update public.control_findings f
     set resolved_at = now(),
         note = coalesce(f.note, '') || case when f.note is null then '' else ' | ' end
                || 'auto-resolved: no longer returned by the control'
   where f.control_key = p_key
     and f.resolved_at is null
     and not (f.entity_id = any (seen));

  update public.controls
     set last_run_at = now(),
         last_run_ms = (extract(epoch from clock_timestamp() - started) * 1000)::int,
         last_violations = n,
         last_error = null
   where key = p_key;

  return n;
end;
$$;

-- ── Runner: every control ────────────────────────────────────────────────────
create or replace function public.run_all_controls()
returns table (control_key text, violations integer, errored boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer;
begin
  for r in select key from public.controls where enabled order by key loop
    begin
      n := public.run_control(r.key);
      control_key := r.key; violations := n; errored := false;
      return next;
    exception when others then
      -- One broken control must not abort the sweep. The error is recorded and
      -- surfaced; it is never mistaken for a clean result.
      update public.controls
         set last_run_at = now(), last_error = sqlerrm, last_violations = null
       where key = r.key;
      control_key := r.key; violations := null; errored := true;
      return next;
    end;
  end loop;
end;
$$;

revoke execute on function public.run_control(text)   from public, anon, authenticated;
revoke execute on function public.run_all_controls()  from public, anon, authenticated;
grant  execute on function public.run_control(text)   to service_role;
grant  execute on function public.run_all_controls()  to service_role;

-- ── Console-facing summary ───────────────────────────────────────────────────
-- One round trip for the /controls page: current open findings by severity, plus
-- any control that is erroring or has never run. A control that has gone silent is
-- reported as loudly as one that is failing.
create or replace function public.control_status()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'open', (
      select coalesce(jsonb_object_agg(severity, n), '{}'::jsonb) from (
        select severity, count(*)::int as n
          from public.control_findings where resolved_at is null group by severity
      ) s
    ),
    'errored', (
      select coalesce(jsonb_agg(jsonb_build_object('key', key, 'error', last_error)), '[]'::jsonb)
        from public.controls where enabled and last_error is not null
    ),
    'stale', (
      select coalesce(jsonb_agg(key), '[]'::jsonb) from public.controls
       where enabled and (last_run_at is null or last_run_at < now() - interval '6 hours')
    ),
    'enabled_count', (select count(*)::int from public.controls where enabled),
    'generated_at', now()
  );
$$;

revoke execute on function public.control_status() from public, anon, authenticated;
grant  execute on function public.control_status() to service_role;
