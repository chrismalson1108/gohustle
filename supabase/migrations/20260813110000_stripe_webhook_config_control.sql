-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing was watching Stripe's webhook configuration, and two failures were sitting
-- in it.
--
-- Found by hand on 2026-08-13, only because Chris installed the Stripe CLI:
--
--   1. The Connect endpoint subscribed to `account.updated` ONLY. The payout.* handler
--      in stripe-webhook was correct, deployed, and receiving nothing — so
--      stripe_payouts could never get a row and Bank deposits would have stayed empty
--      forever, reading to a user as "no deposits yet" rather than "we are not
--      listening".
--   2. Live mode had NO endpoint at all. Flipping the keys would have taken every
--      handler dark at once: captures never marked paid, Connect onboarding never
--      completing, identity never resolving, refunds never recorded.
--
-- Both are invisible from inside the database. `controls` are SQL and cannot reach the
-- Stripe API, so this one is `external = true` and runs inside reconcile-stripe, which
-- already holds a Stripe client and is already dispatched by the hourly sweep.
--
-- ── WHY THIS SHAPE ──────────────────────────────────────────────────────────
--
-- A handler with no subscription is the same failure as trg_notify_safety_report, which
-- sat dead from 2026-07-10 to 2026-08-06 without firing one alert: correct code, wired
-- to nothing, and no error anywhere because nothing was being delivered to fail. The
-- only way to catch that class is to assert the WIRING, not the code.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── A finding writer that is not hardcoded to one control ───────────────────
-- record_reconciliation_finding pins control_key = 'stripe_reconciliation'. Rather than
-- overload it (which would put webhook-config findings under a key whose auto-resolve
-- sweep is driven by payment ids, and would silently close them every run), give
-- external controls a generic writer that validates the key.
create or replace function public.record_external_finding(
  p_control_key text,
  p_entity      text,
  p_detail      jsonb,
  p_severity    text default 'high'
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The key must be a REGISTERED external control. Without this an edge function with
  -- the controls secret could invent findings under any key, including one whose
  -- auto-resolve it does not participate in — findings that could then never be closed.
  if not exists (
    select 1 from public.controls
     where key = p_control_key and coalesce(external, false)
  ) then
    raise exception 'record_external_finding: % is not a registered external control', p_control_key
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.control_findings (control_key, entity_id, severity, detail)
  values (p_control_key, coalesce(p_entity, ''), p_severity, coalesce(p_detail, '{}'::jsonb))
  on conflict (control_key, entity_id) where resolved_at is null
  do update set last_seen_at = now(), detail = excluded.detail;
end;
$$;

revoke execute on function public.record_external_finding(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_external_finding(text, text, jsonb, text) to service_role;

-- Same auto-resolve contract as every other control: a violation the check stops
-- returning is closed, so the board never accumulates entries nobody trusts.
create or replace function public.resolve_external_findings(
  p_control_key text,
  p_still_open  text[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.control_findings f
     set resolved_at = now(),
         note = coalesce(f.note || ' | ', '') || 'auto-resolved: no longer reported'
   where f.control_key = p_control_key
     and f.resolved_at is null
     and not (f.entity_id = any(coalesce(p_still_open, '{}')));
  get diagnostics n = row_count;

  update public.controls
     set last_run_at = now(), last_violations = coalesce(array_length(p_still_open, 1), 0), last_error = null
   where key = p_control_key;

  return n;
end;
$$;

revoke execute on function public.resolve_external_findings(text, text[]) from public, anon, authenticated;
grant execute on function public.resolve_external_findings(text, text[]) to service_role;

-- ── Register it ─────────────────────────────────────────────────────────────
insert into public.controls (key, title, severity, domain, why, fn_name, external) values
  ('stripe_webhook_config',
   'Stripe webhook configuration cannot deliver what the code handles',
   'high', 'money',
   'Every stripe-webhook handler depends on a subscription nobody asserts. On 2026-08-13 '
   'the Connect endpoint carried account.updated ONLY — so the payout.* handler had been '
   'live and receiving nothing, and bank-deposit arrival dates could never populate — '
   'while live mode had no endpoint at all, which would have taken every handler dark '
   'the moment the keys flipped. Neither errors: nothing is delivered, so nothing fails. '
   'Checked from reconcile-stripe because controls are SQL and cannot reach Stripe.',
   'external:reconcile-stripe',
   true)
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, external = true;

-- ── Prove the writer refuses an unregistered key ────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    perform public.record_external_finding('not_a_real_control', 'x', '{}'::jsonb, 'high');
  exception when invalid_parameter_value then
    ok := true;
  end;
  if not ok then
    raise exception 'record_external_finding accepted an unregistered control key';
  end if;

  -- And that it accepts the real one, then cleans up after itself.
  perform public.record_external_finding('stripe_webhook_config', 'selftest', '{"probe":true}'::jsonb, 'low');
  if not exists (select 1 from public.control_findings
                  where control_key = 'stripe_webhook_config' and entity_id = 'selftest') then
    raise exception 'record_external_finding did not write the finding';
  end if;
  delete from public.control_findings
   where control_key = 'stripe_webhook_config' and entity_id = 'selftest';

  raise notice 'external finding writer validates its control key';
end $$;
