-- ─────────────────────────────────────────────────────────────────────────────
-- Stripe reconciliation as a first-class control (2026-08-06).
--
-- THE BLIND SPOT THIS CLOSES
--
-- All 21 existing controls compare the database to ITSELF. Every one of them passes on
-- a ledger that is internally consistent but WRONG about what Stripe actually did — a
-- double-processed webhook, a capture that succeeded at Stripe and failed to write
-- here, a refund issued from the dashboard, an application fee that did not match. Each
-- leaves a tidy, self-consistent, incorrect ledger.
--
-- Reconciliation is the control that does not depend on predicting the bug: it asks the
-- processor. The database is not the authority on money.
--
-- WHY IT NEEDS TWO SMALL SCHEMA CHANGES
--
-- 1. `controls.external` — the checker is an edge function, because SQL cannot call
--    Stripe. run_all_controls() must therefore SKIP it rather than try to EXECUTE a
--    ctl_* function that does not exist. But it stays in the registry so /controls and
--    the digest treat it identically — and, critically, so control_status() still
--    reports it as STALE if it stops running. A reconciliation that silently stops is
--    indistinguishable from one that keeps passing, which is the worst failure this
--    system can have.
--
-- 2. `record_reconciliation_finding()` — the findings index is PARTIAL
--    (`where resolved_at is null`), which PostgREST cannot use as an ON CONFLICT
--    target. This RPC performs the same upsert-then-auto-resolve contract run_control
--    uses, so an externally-checked control behaves exactly like a SQL one.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.controls
  add column if not exists external boolean not null default false;

comment on column public.controls.external is
  'true = checked by an edge function, not a ctl_* SQL function. run_all_controls skips '
  'it; control_status still reports it stale or erroring, which is the point.';

-- Skip external controls in the SQL sweep. Reproduced in full — create or replace
-- needs the whole body.
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
  for r in select key from public.controls where enabled and not external order by key loop
    begin
      n := public.run_control(r.key);
      control_key := r.key; violations := n; errored := false;
      return next;
    exception when others then
      update public.controls
         set last_run_at = now(), last_error = sqlerrm, last_violations = null
       where key = r.key;
      control_key := r.key; violations := null; errored := true;
      return next;
    end;
  end loop;
end;
$$;

revoke execute on function public.run_all_controls() from public, anon, authenticated;
grant execute on function public.run_all_controls() to service_role;

-- Upsert one reconciliation finding, honouring the partial unique index.
create or replace function public.record_reconciliation_finding(
  p_entity text, p_detail jsonb, p_severity text default 'critical'
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.control_findings (control_key, entity_id, severity, detail)
  values ('stripe_reconciliation', coalesce(p_entity, ''), p_severity, coalesce(p_detail, '{}'::jsonb))
  on conflict (control_key, entity_id) where resolved_at is null
  do update set last_seen_at = now(), detail = excluded.detail;
end;
$$;

-- Close anything that now reconciles. Passing the full set of still-broken ids keeps
-- the same auto-resolve contract as run_control: a finding the check stops producing
-- is closed, so the queue never accumulates stale entries nobody trusts.
create or replace function public.resolve_reconciliation_findings(p_still_open text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.control_findings f
     set resolved_at = now(),
         note = coalesce(f.note || ' | ', '') || 'auto-resolved: reconciles against Stripe'
   where f.control_key = 'stripe_reconciliation'
     and f.resolved_at is null
     and not (f.entity_id = any (coalesce(p_still_open, '{}')));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.record_reconciliation_finding(text, jsonb, text)
  from public, anon, authenticated;
revoke execute on function public.resolve_reconciliation_findings(text[])
  from public, anon, authenticated;
grant execute on function public.record_reconciliation_finding(text, jsonb, text) to service_role;
grant execute on function public.resolve_reconciliation_findings(text[]) to service_role;

insert into public.controls (key, title, severity, domain, why, fn_name, external) values
  ('stripe_reconciliation',
   'Payments ledger disagrees with Stripe',
   'critical', 'money',
   'The only control that asks the processor instead of asking ourselves. Catches a '
   'captured total that does not match amount_received, a capture Stripe recorded and '
   'we did not, a refund issued from the dashboard that never clawed back earnings, a '
   'hold that lapsed at Stripe while our ledger still calls it live, and a '
   'PaymentIntent we reference that Stripe has never heard of. Every other control '
   'compares the database to itself and passes on a ledger that is consistent and '
   'wrong.',
   'external:reconcile-stripe', true)
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain,
  fn_name = excluded.fn_name, external = excluded.external;

-- Fire it from the hourly sweep, after the SQL controls.
create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg jsonb; on_ boolean; url text; secret text; base text;
begin
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
    perform net.http_post(
      url     := base || '/reconcile-stripe',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('days', 14, 'limit', 200)
    );
  exception when others then
    raise warning 'stripe reconciliation dispatch failed: %', sqlerrm;
  end;

  if not on_ then return; end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'page', 'since_minutes', 90)
    );
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.controls_sweep_and_page() from public, anon, authenticated;
grant execute on function public.controls_sweep_and_page() to service_role;
