-- ─────────────────────────────────────────────────────────────────────────────
-- The monitoring channel was reporting itself broken, hourly, while working fine.
--
-- pg_net's net.http_post defaults to timeout_milliseconds = 5000. The hourly sweep
-- dispatches reconcile-stripe, which retrieves a PaymentIntent from Stripe for each
-- payment in the window. That legitimately takes longer than five seconds: measured at
-- ~6s (controls.stripe_reconciliation.last_run_at lands 6s after the dispatch, with
-- last_violations = 0 and no error).
--
-- So pg_net abandoned the wait, wrote a row with status_code null and
-- "Timeout of 5000 ms reached", and ctl_alert_dispatch_failing correctly reported that
-- a dispatch did not return 2xx -- concluding the channel that tells you about problems
-- is itself failing. It was not. The request had been made, the function ran to
-- completion, and reconciliation passed. Only the waiting was too short.
--
-- Three findings had accumulated from this, at high severity, on the one channel that
-- must never cry wolf. Alert fatigue is the failure mode the whole control framework
-- exists to avoid, so a monitor that reports false failures is worse than useless.
--
-- Raised to 120s for reconciliation (it scales with the payment window) and 30s for the
-- page. Both are far above the real durations; the point is that a timeout should mean
-- "something is genuinely wrong", not "this job did its work properly".
--
-- The body below is the LIVE pg_proc source with only the two timeout arguments added.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
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
      body    := jsonb_build_object('days', 14, 'limit', 200),
      -- pg_net gives up at 5s by default. Reconciliation retrieves a PaymentIntent from
      -- Stripe per payment and legitimately takes longer -- measured at ~6s -- so the
      -- client abandoned a job that then completed successfully, and
      -- ctl_alert_dispatch_failing reported the monitoring channel as broken roughly
      -- every hour. The work was fine; only the waiting was too short.
      timeout_milliseconds := 120000
    );
  exception when others then
    raise warning 'stripe reconciliation dispatch failed: %', sqlerrm;
  end;

  if not on_ then return; end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'page', 'since_minutes', 90),
      -- Sending an email is fast, but it queries findings first and must never be the
      -- reason a page is recorded as failed.
      timeout_milliseconds := 30000
    );
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke execute on function public.controls_sweep_and_page() from public, anon, authenticated;
