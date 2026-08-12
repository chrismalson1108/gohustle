-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule the control sweep and its alerting (2026-08-06).
--
-- pg_cron runs INSIDE Postgres, which is the entire point: the sweep does not depend
-- on the admin console being open, on Vercel being up, or on anyone being awake. A
-- control that only runs when a human visits a page is a report, not a control.
--
-- Two jobs, because paging and reporting are different products:
--
--   controls_sweep   hourly at :05 — run every enabled control, then POST mode=page.
--                    The function emails ONLY when something newly needs a human (a
--                    new critical/high finding, a control erroring, or a control gone
--                    stale) and is silent otherwise. A channel that speaks when
--                    nothing is wrong stops being read, and then it stops working.
--
--   controls_digest  daily 13:05 UTC (~8am US Central) — POST mode=digest, which
--                    always emails and, when ANTHROPIC_API_KEY is set, includes
--                    Claude's triage of what to look at first.
--
-- Dispatch reads url + secret from app_flags.controls_alert (20260806020000), so the
-- endpoint and secret rotate from the console with no redeploy and no superuser —
-- and, unlike a GUC, the config can be READ BACK and asserted on by a control. That
-- is what makes "is our alerting actually wired up?" a checkable question rather than
-- an assumption, which is the failure that left safety alerting dead for a month.
--
-- The sweep is scheduled at :05 rather than :00 to stay clear of the top-of-hour
-- crowd on shared infrastructure.
--
-- Both jobs are wrapped so a dispatch failure cannot abort the sweep: the findings
-- are already written by then, and losing the email must never mean losing the run.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;

-- Runs every enabled control, then pages if anything newly needs attention.
create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg    jsonb;
  on_    boolean;
  url    text;
  secret text;
begin
  -- Always sweep first. Findings are the durable artefact; alerting is delivery.
  perform public.run_all_controls();

  cfg    := public.alert_config('controls_alert');
  on_    := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    := nullif(cfg->>'url', '');
  secret := coalesce(cfg->>'secret', '');

  if not on_ or url is null then
    return;
  end if;

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

-- Morning digest. Does NOT re-run the sweep; it reports on what the hourly sweeps
-- already found, so the digest can never be the only thing that noticed something.
create or replace function public.controls_digest()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
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
      body    := jsonb_build_object('mode', 'digest')
    );
  exception when others then
    raise warning 'controls digest dispatch failed: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.controls_sweep_and_page() from public, anon, authenticated;
revoke execute on function public.controls_digest()         from public, anon, authenticated;
grant  execute on function public.controls_sweep_and_page() to service_role;
grant  execute on function public.controls_digest()         to service_role;

-- Idempotent (re)scheduling.
select cron.unschedule(jobid) from cron.job where jobname in ('controls_sweep', 'controls_digest');
select cron.schedule('controls_sweep',  '5 * * * *',  $$select public.controls_sweep_and_page()$$);
select cron.schedule('controls_digest', '5 13 * * *', $$select public.controls_digest()$$);
