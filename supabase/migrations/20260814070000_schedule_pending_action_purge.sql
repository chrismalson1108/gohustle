-- ─────────────────────────────────────────────────────────────────────────────
-- purge_assistant_pending_actions exists, is correct, and has never once run.
--
-- 20260813020000 created it with a 24-hour retention window and then scheduled nothing.
-- `cron.job` carries exactly two entries — controls_sweep and controls_digest — so every
-- staged action payload written since that migration is still in the table.
--
-- That matters more than "a table grew". assistant_pending_actions holds the PARAMETERS
-- of an action a user was offered and did not take: the gig they drafted and abandoned,
-- the booking they thought better of, with the amounts and the free text they typed. The
-- migration's own 24-hour window is a retention promise, and an unscheduled purge makes
-- it a promise the system does not keep — which is worse than never having stated one,
-- because anyone reading the migration reasonably concludes the data is transient.
--
-- Scheduled the same way vest_bonuses is: inside controls_sweep_and_page, wrapped in its
-- own exception block. A separate cron entry would be a second thing to notice when it
-- stops running; the hourly sweep is already the thing that must keep working, and it is
-- already monitored. Housekeeping failures must never take the sweep down with them —
-- the controls are the load-bearing half.
--
-- Body copied verbatim from 20260813060000 with one block added. Nothing else changes.
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

-- ── Prove the purge is REACHED, and that it deletes only what it should ─────
do $$
declare
  uid uuid; fresh_id uuid; stale_id uuid;
  fresh_alive boolean; stale_alive boolean;
  body text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- The sweep must actually CALL it. Asserting on the source is the point: the function
  -- was correct all along and simply had no caller, which no amount of testing the
  -- function itself would have revealed.
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'controls_sweep_and_page';
  if body not like '%purge_assistant_pending_actions%' then
    raise exception 'FIX FAILED: the sweep still does not call the purge';
  end if;

  -- summary is NOT NULL: it is the server-computed text the confirmation card renders,
  -- and the whole gate depends on it existing.
  insert into public.assistant_pending_actions (user_id, kind, payload, summary, created_at)
  values (uid, 'create_gig', '{"probe":true}'::jsonb, '{"probe":true}'::jsonb, now())
  returning id into fresh_id;
  insert into public.assistant_pending_actions (user_id, kind, payload, summary, created_at)
  values (uid, 'create_gig', '{"probe":true}'::jsonb, '{"probe":true}'::jsonb, now() - interval '48 hours')
  returning id into stale_id;

  perform public.purge_assistant_pending_actions();

  select exists(select 1 from public.assistant_pending_actions where id = fresh_id) into fresh_alive;
  select exists(select 1 from public.assistant_pending_actions where id = stale_id) into stale_alive;

  if stale_alive then
    raise exception 'FIX FAILED: a 48h-old staged action survived the purge';
  end if;
  if not fresh_alive then
    raise exception 'TOO BROAD: the purge deleted an action staged seconds ago';
  end if;
  raise notice 'purge removes the 48h-old row and keeps the fresh one, and the sweep calls it';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'pending-action purge probe passed; staged rows rolled back';
  else
    raise;
  end if;
end $$;
