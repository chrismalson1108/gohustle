-- ─────────────────────────────────────────────────────────────────────────────
-- H6 (safety-reports-no-alerting-sla): a harassment/assault report must page a human
-- (2026-07-10).
--
-- Before this, a `reports` insert dropped into a poll-only queue — no trigger, no
-- email, no push — so a safety report reached no one until someone happened to check
-- the console. This adds an AFTER INSERT trigger that dispatches the report to the
-- `safety-alert` edge function via pg_net, which emails the on-call owner (Resend).
--
-- Config (set post-deploy; until BOTH are set the trigger is a safe no-op so it never
-- blocks a report insert):
--   alter database postgres set app.safety_alert_url    = 'https://<ref>.functions.supabase.co/safety-alert';
--   alter database postgres set app.safety_alert_secret = '<random-secret>';
-- Deploy the function with `--no-verify-jwt` and set its SAFETY_ALERT_SECRET secret to
-- the SAME value, plus SAFETY_ONCALL_EMAIL + RESEND_API_KEY. (Equivalent alternative:
-- a Supabase Database Webhook on public.reports pointing at the function.)
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_net;

create or replace function public.notify_safety_report()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  url    text := current_setting('app.safety_alert_url', true);
  secret text := coalesce(current_setting('app.safety_alert_secret', true), '');
begin
  -- Not configured yet → do nothing. The safety report is already saved; alerting is
  -- additive and must NEVER roll back the insert.
  if url is null or url = '' then
    return new;
  end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-safety-secret', secret),
      body    := jsonb_build_object('report_id', new.id, 'record', to_jsonb(new))
    );
  exception when others then
    -- Swallow any dispatch error (extension missing, network) — a failed alert must
    -- not lose the report. Surfaces in the Postgres logs for follow-up.
    raise warning 'safety-alert dispatch failed for report %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke execute on function public.notify_safety_report() from public, anon, authenticated;

drop trigger if exists trg_notify_safety_report on public.reports;
create trigger trg_notify_safety_report
  after insert on public.reports
  for each row execute function public.notify_safety_report();
