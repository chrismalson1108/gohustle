-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing watches the edge error sink. It is a report, not a control.
--
-- 20260726130000 created public.client_errors so production failures had somewhere
-- to land, and _shared/logError.ts (2026-08) extended it to the edge functions with
-- an explicit motive written into the file's own header: a failed escrow capture
-- used to `console.error(...)` and stop there, so "the poster pressed pay and it
-- silently didn't work" was invisible until someone complained.
--
-- The sink works. Seven functions call logServerError — stripe-capture-payment,
-- stripe-create-payment-intent, accept-booking, earner-claim-payment, stripe-tip,
-- stripe-webhook and admin-payment-action, i.e. every function that moves money —
-- and the ones that matter mark the terminal catch `{ fatal: true }`. The rows land
-- tagged platform='edge' with the function name in app_version.
--
-- And then nothing reads them on a schedule. The consumers of client_errors are the
-- console page /errors and the `errors_fatal_7d` tile in admin_dashboard_metrics().
-- Both render only when a human opens a page. `grep -n client_errors
-- supabase/migrations/*.sql` finds the DDL, the `dev` column, two comments and that
-- tile — and not one ctl_* function. That is precisely the failure mode the controls
-- framework was built to end: 20260806010000 put the engine in Postgres rather than
-- in a Next.js route because "a check that runs in a Next.js route only runs when a
-- human opens a page". The sink was built to the older standard and never upgraded.
--
-- WHAT THAT COSTS. Rotate STRIPE_SECRET_KEY in the Stripe dashboard on a Friday
-- evening without updating the function secret. Every accept-booking and
-- stripe-create-payment-intent call throws; each writes a fatal row here. Posters see
-- "could not accept" and give up. The existing money controls catch the CONSEQUENCE
-- and catch it late, because they are all keyed on state that a broken function never
-- produces: ctl_settled_without_captured_payment needs a booking that reached
-- confirmed, and ctl_escrow_hold_expiring_work_done needs a hold that was placed. The
-- one thing every one of those failures DOES produce, immediately, is a row in this
-- table. Nobody is looking at it until Monday.
--
-- THE CONTROL. ctl_edge_errors_burst groups the last 90 minutes of platform='edge'
-- rows by app_version and reports a function that is failing repeatedly:
--
--   * >= 3 FATAL rows — fatal means a user-visible operation failed outright, so
--     three of them from one money function inside 90 minutes is never routine, and
--     it is the arm that catches a rotated key or a broken RPC signature on the first
--     sweep after it starts.
--   * >= 10 rows of any severity — the volume arm. Non-fatal rows are bookkeeping
--     retries and reconciliation warnings; a handful is normal and ten from one
--     function in 90 minutes is a function in a loop.
--
-- WHY 90 MINUTES and not the 60 the window nominally needs: the sweep is hourly at
-- :05, so a 60-minute window tiles exactly and a single skipped cron run drops a
-- burst into a gap nothing ever looks at. 90 gives consecutive sweeps 30 minutes of
-- overlap, and it matches controls-alert's own `since_minutes` default of 90 for
-- deciding a finding is new. The window is rolling, so a burst that stops
-- auto-resolves on a later sweep the way run_control resolves anything a control
-- stops returning — this reports "failing NOW", never "failed once in July".
--
-- ONE ROW PER FUNCTION, never one per error. run_control upserts findings on
-- (control_key, entity_id) and two rows sharing an entity_id abort the whole control
-- with a cardinality violation, which is recorded as ERRORED — a more confusing
-- failure than the one being reported. The group by is the guarantee.
--
-- severity 'high' is deliberate: controls-alert's page mode emails only for new
-- critical/high findings, and a money function that cannot complete a call is the
-- thing the pager exists for. domain 'money' is accurate today because all seven
-- callers are money functions; if a non-money function ever adopts the sink the
-- finding is still correct, only filed under a domain that is then a shade too narrow.
--
-- SCOPE, deliberately narrow. platform='edge' only. The same table carries
-- 'ios'/'android'/'web' rows from log-client-error, and a client burst is a real
-- signal with a completely different baseline — one user on a bad network can write
-- ten rows without anything being wrong on the platform. Watching those needs its own
-- thresholds and its own control; folding them in here would either miss the edge
-- signal or cry wolf, and a control that cries wolf is a control somebody deletes.
-- `dev` rows are excluded for the reason 20260804010000 added the column: a local
-- Metro crash is not production. (An edge row is never dev in practice — logError.ts
-- does not set it — so this is a fence, not a filter.)
-- ─────────────────────────────────────────────────────────────────────────────

-- The window predicate is (platform, created_at); the existing indexes are on
-- created_at alone. At this table's size either is fine, but the sweep runs hourly
-- forever and client_errors only grows.
create index if not exists client_errors_edge_recent_idx
  on public.client_errors (created_at desc)
  where platform = 'edge' and dev = false;

create or replace function public.ctl_edge_errors_burst()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with recent as (
    select coalesce(nullif(app_version, ''), 'unknown') as fn,
           message,
           fatal,
           created_at
      from public.client_errors
     where platform = 'edge'
       and dev = false
       and created_at > now() - interval '90 minutes'
  ), msgs as (
    -- Distinct messages per function, most recent first. Rolled up in its own CTE rather
    -- than as a subquery in the select list: a derived table that reaches up a query
    -- level for `g.fn` is the kind of thing that works until someone rewrites it, and a
    -- control that fails to PARSE is recorded as errored, which reads like an incident.
    select fn,
           left(message, 300)                                                as msg,
           max(created_at)                                                   as seen,
           row_number() over (partition by fn order by max(created_at) desc) as rn
      from recent
     group by fn, left(message, 300)
  ), grouped as (
    select fn,
           count(*)                                    as errors,
           count(*) filter (where fatal)               as fatal_errors,
           count(distinct message)                     as distinct_messages,
           min(created_at)                             as first_at,
           max(created_at)                             as last_at
      from recent
     group by fn
    having count(*) filter (where fatal) >= 3
        or count(*) >= 10
  )
  select g.fn,
         jsonb_build_object(
           -- Slugs rather than sentences, the same choice ctl_alert_not_dispatching
           -- makes: greppable, and stable across rewording for a finding that persists.
           'tripped', to_jsonb(array_remove(array[
             case when g.fatal_errors >= 3 then 'fatal_burst' end,
             case when g.errors      >= 10 then 'volume_burst' end
           ]::text[], null)),
           'window_minutes', 90,
           'errors', g.errors,
           'fatal_errors', g.fatal_errors,
           'distinct_messages', g.distinct_messages,
           'first_at', g.first_at,
           'last_at', g.last_at,
           -- The three most recent distinct messages, capped: enough to tell a rotated
           -- key from a broken RPC signature without pasting a Stripe error blob into
           -- the digest email.
           'sample_messages', coalesce((
             select jsonb_agg(m.msg order by m.seen desc)
               from msgs m
              where m.fn = g.fn and m.rn <= 3
           ), '[]'::jsonb),
           'note', 'A money edge function is failing repeatedly right now. The rows are '
                   'in the admin console at /errors filtered to this function; the usual '
                   'causes are a rotated Stripe key the function env does not have, an '
                   'RPC signature changed by a migration the functions were not '
                   'redeployed against, or a Stripe outage. The downstream money '
                   'controls cannot see this: they are keyed on state a broken function '
                   'never produces.')
    from grouped g
$$;

revoke execute on function public.ctl_edge_errors_burst()
  from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('edge_errors_burst',
   'A money edge function is failing repeatedly — the edge error sink is bursting',
   'high', 'money',
   'logServerError exists because a failed escrow capture used to console.error and '
   'stop there, so a poster pressing pay and silently getting nothing was invisible '
   'until someone complained. The rows now land in client_errors, and until this '
   'control nothing read them on a schedule: the only consumers were the /errors page '
   'and a dashboard tile, both of which render when a human opens them. A rotated '
   'Stripe key or an RPC signature broken by a migration makes every call to a money '
   'function throw; the downstream money controls are keyed on state a broken function '
   'never produces, so they stay silent while nobody is paid. This is the signal that '
   'exists at the moment it starts.',
   'ctl_edge_errors_burst')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Prove it discriminates, on staged rows, rolled back ─────────────────────
do $$
declare
  watchers   int;
  base_rows  int;
  d          jsonb;
  n          int;
  i          int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- OLD BEHAVIOUR, asserted against pg_proc rather than remembered: before this
  -- migration not one registered control read the sink. This is the finding itself,
  -- and it is what makes every staged burst below invisible on the old code.
  select count(*) into watchers
    from public.controls c
    join pg_proc p on p.proname = c.fn_name
    join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public'
   where c.fn_name <> 'ctl_edge_errors_burst'
     and pg_get_functiondef(p.oid) like '%client_errors%';
  raise notice 'OLD behaviour: % registered control(s) other than this one read client_errors. That is the bug.', watchers;
  if watchers <> 0 then
    raise exception 'probe invalid: something else already watches the sink (%)', watchers;
  end if;

  -- Baseline against live data rather than assuming the table is quiet in the window.
  -- A probe whose assertion depends on production being idle proves nothing on the day
  -- production is not.
  select count(*) into base_rows from public.ctl_edge_errors_burst();
  raise notice 'live sink as it stands: % edge function(s) currently bursting', base_rows;

  -- ── Below both thresholds: two fatal rows. Must stay silent. ──────────────
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal)
  select null::uuid, 'edge', 'probe-quiet-fn', 'probe below threshold ' || g,
         '{"probe":true}'::jsonb, true
    from generate_series(1, 2) g;
  if exists (select 1 from public.ctl_edge_errors_burst() where entity_id = 'probe-quiet-fn') then
    raise exception 'FIX FAILED: two fatal errors tripped the control — it will cry wolf';
  end if;
  raise notice 'two fatal rows: silent, as intended';

  -- ── The fatal arm: a third fatal row inside the window ───────────────────
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal)
  values (null, 'edge', 'probe-quiet-fn', 'probe below threshold 3',
          '{"probe":true}'::jsonb, true);
  select detail into d from public.ctl_edge_errors_burst() where entity_id = 'probe-quiet-fn';
  if d is null then
    raise exception 'FIX FAILED: three fatal errors from one money function and the control is silent';
  end if;
  if not (d->'tripped' @> '["fatal_burst"]'::jsonb) then
    raise exception 'FIX FAILED: the fatal arm is not named: %', d->'tripped';
  end if;
  if (d->>'fatal_errors')::int <> 3 or (d->>'errors')::int <> 3 then
    raise exception 'FIX FAILED: miscounted the burst: %', d;
  end if;
  if jsonb_array_length(d->'sample_messages') <> 3 then
    raise exception 'FIX FAILED: no usable sample on the finding: %', d->'sample_messages';
  end if;
  raise notice 'NEW behaviour on the same data: named, tripped %, % errors', d->'tripped', d->>'errors';

  -- ── The volume arm: nine non-fatal rows are quiet, the tenth is not ──────
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal)
  select null::uuid, 'edge', 'probe-noisy-fn', 'probe non-fatal ' || g,
         '{"probe":true}'::jsonb, false
    from generate_series(1, 9) g;
  if exists (select 1 from public.ctl_edge_errors_burst() where entity_id = 'probe-noisy-fn') then
    raise exception 'FIX FAILED: nine non-fatal rows tripped the volume arm';
  end if;
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal)
  values (null, 'edge', 'probe-noisy-fn', 'probe non-fatal 10', '{"probe":true}'::jsonb, false);
  select detail into d from public.ctl_edge_errors_burst() where entity_id = 'probe-noisy-fn';
  if d is null or not (d->'tripped' @> '["volume_burst"]'::jsonb) then
    raise exception 'FIX FAILED: ten non-fatal rows did not trip the volume arm: %', d;
  end if;
  if (d->'tripped' @> '["fatal_burst"]'::jsonb) then
    raise exception 'FIX FAILED: named the fatal arm on a burst with no fatal rows: %', d->'tripped';
  end if;
  raise notice 'volume arm: nine silent, ten named';

  -- ── The window is rolling: yesterday must not page today ─────────────────
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal, created_at)
  select null::uuid, 'edge', 'probe-old-fn', 'probe stale ' || g, '{"probe":true}'::jsonb, true,
         now() - interval '3 hours'
    from generate_series(1, 5) g;
  if exists (select 1 from public.ctl_edge_errors_burst() where entity_id = 'probe-old-fn') then
    raise exception 'FIX FAILED: a burst that ended hours ago is still being reported';
  end if;
  raise notice 'a burst outside the window: silent, so a resolved incident auto-resolves';

  -- ── Scope: client rows are a different signal with a different baseline ──
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal)
  select null::uuid, 'ios', '1.4.2', 'probe client crash ' || g, '{"probe":true}'::jsonb, true
    from generate_series(1, 12) g;
  if exists (select 1 from public.ctl_edge_errors_burst() where entity_id = '1.4.2') then
    raise exception 'FIX FAILED: a client crash burst was reported by the edge control';
  end if;

  -- ── And dev rows are not production ──────────────────────────────────────
  insert into public.client_errors (user_id, platform, app_version, message, context, fatal, dev)
  select null::uuid, 'edge', 'probe-dev-fn', 'probe dev ' || g, '{"probe":true}'::jsonb, true, true
    from generate_series(1, 6) g;
  if exists (select 1 from public.ctl_edge_errors_burst() where entity_id = 'probe-dev-fn') then
    raise exception 'FIX FAILED: a local dev burst was reported as a production incident';
  end if;
  raise notice 'client rows and dev rows: both out of scope, both silent';

  -- ── One finding per function, and run_control can actually record them ───
  select count(*) into i from public.ctl_edge_errors_burst() where entity_id = 'probe-quiet-fn';
  if i <> 1 then
    raise exception 'FIX FAILED: % rows for one function — run_control aborts on the upsert', i;
  end if;
  n := public.run_control('edge_errors_burst');
  if n <> base_rows + 2 then
    raise exception 'FIX FAILED: run_control recorded % findings, expected % (baseline % + 2 staged)',
      n, base_rows + 2, base_rows;
  end if;
  if not exists (
    select 1 from public.control_findings
     where control_key = 'edge_errors_burst' and entity_id = 'probe-quiet-fn'
       and resolved_at is null and severity = 'high'
  ) then
    raise exception 'FIX FAILED: the finding did not record at the paging severity';
  end if;
  raise notice 'run_control wrote % findings, one per bursting function, at high severity', n;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'edge-sink-watch probe passed; every staged error row rolled back';
  else
    raise;
  end if;
end $$;
