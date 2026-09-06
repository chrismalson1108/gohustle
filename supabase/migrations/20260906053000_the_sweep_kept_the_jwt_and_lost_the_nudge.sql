-- ─────────────────────────────────────────────────────────────────────────────
-- The sweep lost the check-in nudge when it was rewritten for the JWT fix.
--
-- 20260905002200 added `run_safety_checkin_stages()` as the FIRST step of the hourly
-- sweep: ask the worker before paging a human, so a page means "we asked and got
-- nothing back" rather than "somebody forgot to tap a button".
--
-- 20260906034000 then rewrote controls_sweep_and_page to stamp a service_role JWT —
-- correct, and necessary, because pg_cron carries no JWT and guard_bookings_write
-- denies by default, which is why expire_stale_pending_bookings had never cancelled
-- anything from cron. But it was written against the older base and reinstated that
-- base's body, so the nudge call disappeared. `create or replace` keeps only the last
-- definition, and __tests__/safetyCheckinNudge.test.js caught it.
--
-- This is the union: the JWT stamp AND the nudge stage, in the right order.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg jsonb; on_ boolean; url text; secret text; base text;
begin
  -- pg_cron carries no JWT, so auth.role() and auth.uid() are NULL here. Several guards
  -- (guard_bookings_write above all) exempt service_role and deny-by-default for anyone
  -- else, so without this the housekeeping below either raises — swallowed by its own
  -- exception block into a warning — or silently pins the columns it meant to change.
  -- Transaction-local: pg_cron gives each run its own transaction, so it cannot leak.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Stage one of the safety check-in, and stage two for anything that ignored it.
  -- FIRST, so the page that follows means "we asked and got nothing back". Added by
  -- 20260905002200 and lost when 20260906034000 rewrote this function from the older
  -- base; restored here rather than left to the next reader to notice.
  begin
    perform public.run_safety_checkin_stages();
  exception when others then
    raise warning 'safety checkin stages failed: %', sqlerrm;
  end;

  begin
    perform public.vest_bonuses();
  exception when others then
    raise warning 'bonus vesting failed: %', sqlerrm;
  end;

  begin
    perform public.expire_stale_pending_bookings(14);
  exception when others then
    raise warning 'stale pending expiry failed: %', sqlerrm;
  end;

  -- Listings whose every slot is in the past. Without this a finished gig keeps being
  -- offered — including back to the person who already worked it.
  begin
    perform public.expire_dead_listings();
  exception when others then
    raise warning 'dead listing expiry failed: %', sqlerrm;
  end;

  -- Staged-but-never-confirmed assistant actions, past their stated 24h window. These
  -- carry the parameters of things a user was offered and declined, so the retention
  -- window in 20260813020000 is a promise; until now nothing kept it.
  begin
    perform public.purge_assistant_pending_actions();
  exception when others then
    raise warning 'assistant pending-action purge failed: %', sqlerrm;
  end;

  perform public.run_all_controls();

  cfg    := public.alert_config('controls_alert');
  on_    := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    := nullif(cfg->>'url', '');
  secret := coalesce(cfg->>'secret', '');
  if url is null then return; end if;
  base := regexp_replace(url, '/controls-alert$', '');

  begin
    perform net.http_post(
      url     := base || '/reconcile-stripe',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('days', 14, 'limit', 200),
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
      body    := jsonb_build_object('mode', 'page'),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$function$;


-- ── Prove the live body carries both ───────────────────────────────────────
do $$
declare b text;
begin
  select pg_get_functiondef(p.oid) into b
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'controls_sweep_and_page';
  if b is null then raise exception 'controls_sweep_and_page is missing'; end if;
  if b not like '%run_safety_checkin_stages%' then
    raise exception 'FIX FAILED: the sweep does not ask the worker before paging';
  end if;
  if b not like '%set_config(''request.jwt.claims''%' then
    raise exception 'FIX FAILED: the sweep lost its service_role stamp, so its housekeeping is denied again';
  end if;
  if b not like '%run_all_controls%' then
    raise exception 'the sweep lost run_all_controls in the rewrite';
  end if;
  if strpos(b, 'run_safety_checkin_stages') > strpos(b, 'run_all_controls') then
    raise exception 'the nudge runs AFTER the controls, so the first sweep still pages someone nobody asked';
  end if;
  raise notice 'the sweep stamps service_role, asks the worker, then runs the controls';
end $$;
