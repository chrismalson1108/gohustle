-- ─────────────────────────────────────────────────────────────────────────────
-- Two alert dispatches still run on pg_net's 5-second default. Both timed out today.
--
-- ctl_alert_dispatch_failing flagged two non-2xx dispatches, at 12:05 and 13:05:
--
--   Timeout of 5000 ms reached. Total time: 5000.7 ms
--     (DNS 35ms, TCP/SSL 24.6ms, HTTP request/response 4940ms)
--
-- DNS and the handshake were instant; the edge function itself took the whole
-- budget. That is a cold start, and 5 seconds is simply not enough for one — the
-- hourly sweeps at 14:05 through 17:05 all returned 200 once the function was warm.
-- So the alerting channel is not broken; it is under-provisioned, which produces a
-- worse failure than being broken because it works right up until the moment
-- something is different.
--
-- controls_sweep_and_page already passes timeout_milliseconds on both of its calls.
-- These two were missed:
--
--   • controls_digest — the 13:05 casualty. It runs ONCE A DAY, so a single timeout
--     is a whole day with no digest, and nothing retries it.
--
--   • notify_safety_report — the worse one. This fires when a user files a SAFETY
--     report. It is wrapped in an exception handler that downgrades any failure to a
--     warning, by design, so a report is never lost to a broken pager — but that also
--     means a swallowed safety alert looks like silence. This path already sat dead
--     from 2026-07-10 to 2026-08-06 without a single alert firing, which is precisely
--     why alert config was moved out of GUCs and into an assertable table. Losing it
--     again to a cold start would be the same outcome by a different route.
--
-- 20 seconds: comfortably past a cold start, still far below the statement timeout,
-- and pg_net is asynchronous — the caller enqueues and returns, so a slow response
-- never holds a trigger or a cron job open.
--
-- Reproduced from the LIVE pg_proc bodies. Everything else is byte-for-byte
-- unchanged; the only edit in each is the added timeout_milliseconds argument.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.controls_digest()
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'extensions'
as $function$
declare
  cfg    jsonb := public.alert_config('controls_alert');
  on_    boolean := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    text := nullif(cfg->>'url', '');
  secret text := coalesce(cfg->>'secret', '');
begin
  if not on_ or url is null then
    return;
  end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'digest'),
      -- Daily, with no retry: one cold start used to cost the whole day's digest.
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning 'controls digest dispatch failed: %', sqlerrm;
  end;
end;
$function$;

create or replace function public.notify_safety_report()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'net', 'extensions'
as $function$
declare
  cfg    jsonb := public.alert_config('safety_alert');
  on_    boolean := coalesce((select enabled from public.app_flags where key = 'safety_alert'), true);
  url    text := coalesce(nullif(cfg->>'url', ''), current_setting('app.safety_alert_url', true));
  secret text := coalesce(nullif(cfg->>'secret', ''), current_setting('app.safety_alert_secret', true), '');
begin
  if not on_ or url is null or url = '' then
    return new;
  end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-safety-secret', secret),
      body    := jsonb_build_object('report_id', new.id, 'record', to_jsonb(new)),
      -- A safety report is the one alert that must not be lost to a cold start. The
      -- handler below deliberately never fails the insert, so a swallowed dispatch is
      -- indistinguishable from no report at all.
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning 'safety-alert dispatch failed for report %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

-- Assert every alert dispatch now sets an explicit timeout, so a future rewrite
-- cannot quietly drop back to the 5s default the way these two did.
do $$
declare
  bad text;
begin
  select string_agg(p.proname, ', ')
    into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('controls_sweep_and_page', 'controls_digest', 'notify_safety_report')
     and pg_get_functiondef(p.oid) like '%net.http_post%'
     and pg_get_functiondef(p.oid) not like '%timeout_milliseconds%';
  if bad is not null then
    raise exception 'dispatch function(s) still on the 5s pg_net default: %', bad;
  end if;
  raise notice 'all alert dispatches set an explicit timeout';
end $$;
