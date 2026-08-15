-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing watches the alerting flags. The 2026-07-10 silence, with a new key.
--
-- 20260806020000 moved dispatch config out of a GUC into app_flags and said why:
-- "a control can now check 'is alerting configured?' and page if not". 20260806030000
-- repeated it: "the config can be READ BACK and asserted on by a control. That is what
-- makes 'is our alerting actually wired up?' a checkable question". No such control was
-- ever written. The registry holds 43 controls; not one of them reads app_flags for
-- alerting state.
--
-- So every dispatcher can be silenced with no cost and no tell:
--   controls_sweep_and_page  20260806330000:69  if not on_ then return
--   controls_digest          20260806030000:86  if not on_ or url is null then return
--   notify_safety_report     20260806020000:85  if not on_ or url is null then return
-- Each returns BEFORE net.http_post. The only control watching alerting,
-- ctl_alert_dispatch_failing (20260806160000), reads net._http_response — it can only
-- see dispatches that were ATTEMPTED and came back non-2xx. A dispatch never attempted
-- writes no row, so the control returns zero rows, any existing finding AUTO-RESOLVES
-- on the next sweep (run_control resolves what a control stops returning), and
-- /controls goes green. Controls keep running, keep writing findings, and nobody is
-- told. That is the exact shape of the failure this framework was built to end, and it
-- is worse than the GUC version in one way: switching it off is the natural response to
-- ctl_alert_dispatch_failing being noisy, and doing so ERASES the finding that was
-- complaining.
--
-- THREE PARTS.
--
-- 1. LIVENESS YOU CAN PROVE, not failure you happen to catch. public.alert_dispatches
--    records every dispatch we attempt, with the pg_net request id, so "no page has
--    been sent in three hours" becomes a fact in a table rather than an absence in
--    somebody's inbox. The reconcile-stripe dispatch is logged under its OWN channel
--    on purpose: it sits BEFORE the `if not on_` return, so it keeps firing while
--    paging is off, and sharing a channel with the pager would let those rows certify a
--    dead pager as alive.
--
-- 2. ctl_alert_not_dispatching — reads app_flags directly. Missing row, enabled=false,
--    blank url, blank secret, or a configured channel that has not attempted a dispatch
--    in over three hours. Four config shapes because they are four different ways to
--    the same silence and only one of them is a switch.
--
-- 3. AUTO-EXPIRY, SCOPED. 20260806350000 gave the controls table a 24h expiry on
--    disabling, so silencing detection has to be renewed rather than forgotten. The
--    alerting flags get the same valve — AND ONLY THOSE TWO. Applying it to
--    payments_enabled or posting_enabled would resume taking money 24 hours into a
--    Stripe incident, on a timer, with nobody deciding: a kill switch that un-kills
--    itself is the wrong-direction failure, and is not what this fixes.
--
-- A finding from part 2 still cannot be emailed while dispatch is off. That is
-- unavoidable and it is why part 3 carries the weight: the maximum silence becomes 24
-- hours instead of unbounded. /flags already lists paused keys in a red banner
-- (flags/page.tsx:46-52); /controls should show this finding as a banner too.
--
-- ALSO FIXED HERE, same shape, one line: ctl_stripe_id_mode_mismatch (20260806350000,
-- registered CRITICAL) reads app_flags.stripe_mode as its declared truth and both arms
-- of its union are gated on mode = 'live'. No migration ever seeded that key, and
-- setFlag refuses to create keys ("Flags are seeded by migration, not created here",
-- flags/actions.ts:44-47), so there is no route by which the row can come to exist. The
-- control has returned zero rows since the day it shipped and reports green while 7
-- connected accounts and 4 customers hold test-mode ids. Seeded below as 'test', which
-- is today's truth; flipping the value at cutover is what arms it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Proof that a dispatch was attempted ───────────────────────────────────
create table if not exists public.alert_dispatches (
  id           bigint generated always as identity primary key,
  channel      text not null,
  mode         text not null,
  request_id   bigint,
  attempted_at timestamptz not null default now()
);

create index if not exists alert_dispatches_channel_idx
  on public.alert_dispatches (channel, attempted_at desc);

comment on table public.alert_dispatches is
  'One row per alert dispatch we ATTEMPTED, with the pg_net request id. '
  'net._http_response only records attempts that produced a response, so it cannot '
  'distinguish "alerting is healthy" from "alerting was never called". This can.';

-- Same posture as app_flags / controls: RLS on, no policies, inert to clients.
alter table public.alert_dispatches enable row level security;
revoke all on public.alert_dispatches from anon, authenticated;
grant  all on public.alert_dispatches to service_role;

-- Logging must never be the reason a safety report fails to insert, so the whole body
-- is inside an exception handler. Retention is pruned here rather than by another cron
-- job: three rows an hour, thirty days, no scheduling to forget.
create or replace function public.log_alert_dispatch(
  p_channel text, p_mode text, p_request_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.alert_dispatches (channel, mode, request_id)
  values (p_channel, p_mode, p_request_id);
  delete from public.alert_dispatches where attempted_at < now() - interval '30 days';
exception when others then
  raise warning 'alert dispatch logging failed (%/%): %', p_channel, p_mode, sqlerrm;
end;
$$;

revoke execute on function public.log_alert_dispatch(text, text, bigint)
  from public, anon, authenticated;
grant  execute on function public.log_alert_dispatch(text, text, bigint) to service_role;

-- ── 2. Auto-expiry on the two alerting flags, and nothing else ───────────────
alter table public.app_flags
  add column if not exists disabled_until  timestamptz,
  add column if not exists disabled_reason text;

comment on column public.app_flags.disabled_until is
  'Only meaningful for safety_alert and controls_alert: when the mute lapses and the '
  'channel switches itself back on. Deliberately NOT applied to the feature kill '
  'switches — payments_enabled must never un-pause itself on a timer.';

create or replace function public.trg_alert_flag_disable_expires()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key not in ('safety_alert', 'controls_alert') then
    return new;
  end if;
  if not new.enabled then
    if old.enabled or new.disabled_until is null then
      new.disabled_until := coalesce(
        nullif(new.disabled_until, old.disabled_until),
        now() + interval '24 hours');
    end if;
  else
    new.disabled_until  := null;
    new.disabled_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_z_alert_flag_disable_expires on public.app_flags;
create trigger trg_z_alert_flag_disable_expires
  before update of enabled, disabled_until on public.app_flags
  for each row execute function public.trg_alert_flag_disable_expires();

-- Anything already off gets a window too, so the fix cannot be pre-dated.
update public.app_flags
   set disabled_until = coalesce(disabled_until, now() + interval '24 hours')
 where not enabled
   and key in ('safety_alert', 'controls_alert');

create or replace function public.reenable_expired_alert_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.app_flags
     set enabled = true,
         disabled_until = null,
         disabled_reason = null,
         updated_at = now()
   where key in ('safety_alert', 'controls_alert')
     and not enabled
     and disabled_until is not null
     and disabled_until <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.reenable_expired_alert_flags()
  from public, anon, authenticated;
grant  execute on function public.reenable_expired_alert_flags() to service_role;

-- ── 3. The control ───────────────────────────────────────────────────────────
create or replace function public.ctl_alert_not_dispatching()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with required (key, periodic) as (
    values ('controls_alert', true), ('safety_alert', false)
  ),
  cfg as (
    select r.key,
           r.periodic,
           f.key is not null              as present,
           coalesce(f.enabled, true)      as enabled,
           nullif(f.value->>'url', '')    as url,
           nullif(f.value->>'secret', '') as secret,
           f.disabled_until,
           f.updated_by,
           f.updated_at
      from required r
      left join public.app_flags f on f.key = r.key
  )
  -- (a) The channel cannot dispatch at all. Four distinct causes, one silence.
  select c.key,
         jsonb_build_object(
           'cause', case
             when not c.present then 'no app_flags row — the dispatcher reads value->>''url'' '
                                     'from a row that does not exist and returns before it posts'
             when not c.enabled then 'switched off — every dispatcher early-returns before net.http_post'
             when c.url is null then 'value.url is blank — the dispatcher returns before it posts'
             else 'value.secret is blank — controls-alert answers 503 not_configured, '
                  'safety-alert rejects the call' end,
           'enabled', c.enabled,
           'has_url', c.url is not null,
           'has_secret', c.secret is not null,
           'disabled_until', c.disabled_until,
           'changed_by', c.updated_by,
           'changed_at', c.updated_at,
           'note', 'controls still run and findings are still written. Nobody is being '
                   'told about them. This finding cannot be emailed either.')
    from cfg c
   where not c.present or not c.enabled or c.url is null or c.secret is null
  union all
  -- (b) Configured, on, and still not firing. Proof of liveness, not absence of
  -- failure: the hourly sweep dispatches controls_alert every hour at :05, so three
  -- hours of nothing means the cron job is gone, the sweep is erroring before the
  -- dispatch, or someone replaced the function with one that does not log. Only
  -- periodic channels are checked — safety alerts are event-driven and rightly silent
  -- for weeks.
  select c.key,
         jsonb_build_object(
           'cause', 'configured and enabled, but no dispatch has been ATTEMPTED on this '
                    'channel in over 3 hours',
           'last_attempt_at', (select max(d.attempted_at)
                                 from public.alert_dispatches d where d.channel = c.key),
           'note', 'a channel that is switched on but never called is indistinguishable '
                   'from a healthy one unless attempts are recorded')
    from cfg c
   where c.periodic
     and c.present and c.enabled and c.url is not null and c.secret is not null
     and coalesce((select max(d.attempted_at)
                     from public.alert_dispatches d where d.channel = c.key),
                  '-infinity'::timestamptz) < now() - interval '3 hours'
$$;

revoke execute on function public.ctl_alert_not_dispatching()
  from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('alert_not_dispatching',
   'An alert channel is switched off, unconfigured, or has stopped firing',
   'high', 'security',
   'Two migrations promised a control that reads the dispatch config back and pages if '
   'alerting is not wired up; none was written. ctl_alert_dispatch_failing reads '
   'net._http_response, so it only sees dispatches that were ATTEMPTED and failed — a '
   'dispatch never attempted produces no row, the control returns nothing, its finding '
   'auto-resolves, and /controls renders green while every money and safety finding '
   'goes undelivered. That is the state safety alerting sat in from 2026-07-10 to '
   '2026-08-06. Silencing this channel is legitimate during a noisy incident; it must '
   'cost a line in the digest and expire in 24 hours rather than being a decision made '
   'once and forgotten.',
   'ctl_alert_not_dispatching')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── 4. Dispatchers: re-enable first, log every attempt ───────────────────────
-- REPRODUCED FROM THE LAST DEFINITION IN TIMESTAMP ORDER (20260806330000), which is
-- what is live — not from the migration whose header reads most current. Changed:
-- the re-enable call at the top, and `perform net.http_post` becomes `select … into
-- req` so the request id can be logged. Nothing else moved, including the fact that
-- the reconcile dispatch sits before the `if not on_` return.
create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cfg jsonb; on_ boolean; url text; secret text; base text; req bigint;
begin
  -- A lapsed mute is lifted BEFORE the flag is read, so a channel whose 24h window
  -- expired pages in THIS run rather than the next one — the same ordering, and the
  -- same reason, as reenable_expired_controls inside run_all_controls.
  begin
    perform public.reenable_expired_alert_flags();
  exception when others then
    raise warning 'alert flag re-enable failed: %', sqlerrm;
  end;

  begin
    perform public.vest_bonuses();
  exception when others then
    raise warning 'bonus vesting failed: %', sqlerrm;
  end;

  perform public.run_all_controls();

  cfg    := public.alert_config('controls_alert');
  on_    := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    := nullif(cfg->>'url', '');
  secret := coalesce(cfg->>'secret', '');
  if url is null then return; end if;
  base := regexp_replace(url, '/controls-alert$', '');

  -- Reconciliation BEFORE the page, so a discrepancy it finds is included in the same
  -- alert rather than waiting an hour to be mentioned.
  begin
    select net.http_post(
      url     := base || '/reconcile-stripe',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('days', 14, 'limit', 200),
      timeout_milliseconds := 120000
    ) into req;
    -- Its OWN channel. This dispatch happens whether or not paging is enabled, so
    -- logging it as 'controls_alert' would let it satisfy the pager's liveness check
    -- and certify a dead pager as alive.
    perform public.log_alert_dispatch('stripe_reconcile', 'reconcile', req);
  exception when others then
    raise warning 'stripe reconciliation dispatch failed: %', sqlerrm;
  end;

  if not on_ then return; end if;
  begin
    select net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'page', 'since_minutes', 90),
      timeout_milliseconds := 30000
    ) into req;
    perform public.log_alert_dispatch('controls_alert', 'page', req);
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke execute on function public.controls_sweep_and_page() from public, anon, authenticated;
grant  execute on function public.controls_sweep_and_page() to service_role;

-- Reproduced from 20260806030000 (still the last definition) with the log added.
create or replace function public.controls_digest()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg    jsonb   := public.alert_config('controls_alert');
  on_    boolean := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    text    := nullif(cfg->>'url', '');
  secret text    := coalesce(cfg->>'secret', '');
  req    bigint;
begin
  if not on_ or url is null then
    return;
  end if;
  begin
    select net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'digest')
    ) into req;
    perform public.log_alert_dispatch('controls_alert', 'digest', req);
  exception when others then
    raise warning 'controls digest dispatch failed: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.controls_digest() from public, anon, authenticated;
grant  execute on function public.controls_digest() to service_role;

-- Reproduced from 20260806020000 (still the last definition) with the log added. The
-- never-roll-back-the-report behaviour is untouched: the log call is inside the same
-- exception block as the dispatch.
create or replace function public.notify_safety_report()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg    jsonb := public.alert_config('safety_alert');
  on_    boolean := coalesce((select enabled from public.app_flags where key = 'safety_alert'), true);
  url    text := coalesce(nullif(cfg->>'url', ''), current_setting('app.safety_alert_url', true));
  secret text := coalesce(nullif(cfg->>'secret', ''), current_setting('app.safety_alert_secret', true), '');
  req    bigint;
begin
  if not on_ or url is null or url = '' then
    return new;
  end if;
  begin
    select net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-safety-secret', secret),
      body    := jsonb_build_object('report_id', new.id, 'record', to_jsonb(new))
    ) into req;
    perform public.log_alert_dispatch('safety_alert', 'report', req);
  exception when others then
    raise warning 'safety-alert dispatch failed for report %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke execute on function public.notify_safety_report() from public, anon, authenticated;

-- ── 5. Seed the key ctl_stripe_id_mode_mismatch has been waiting for ─────────
-- Registered CRITICAL, gated on mode = 'live', reading a row that has never existed.
-- Zero rows since the day it shipped, reported as passing. Seeded as 'test' — today's
-- truth — so flipping value->>'mode' at cutover is what arms it, and so a control that
-- claims to check the most likely way the live cutover breaks can actually run.
insert into public.app_flags (key, enabled, value, note) values
  ('stripe_mode', true, jsonb_build_object('mode', 'test'),
   'Declared Stripe mode. Read by ctl_stripe_id_mode_mismatch as the truth stored ids '
   'are checked against. Set value.mode to "live" as part of the cutover, BEFORE the '
   'keys are swapped, so the control names every stale test-mode id first. This is not '
   'a kill switch: `enabled` is unused here.')
on conflict (key) do nothing;
