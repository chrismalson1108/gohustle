-- ─────────────────────────────────────────────────────────────────────────────
-- The check-in "nudge" was designed, documented, promised to a worried friend — and
-- never built. The first thing that happened was a critical page to staff.
--
-- 20260806180000's own header states the design: "Two stages on purpose: most overdue
-- gigs are somebody who forgot to tap done, and escalating those immediately trains
-- everyone to ignore the alert that matters." safety_checkins.nudged_at and
-- escalated_at were created for those two stages. Nothing in the repository ever wrote
-- either column — grep across supabase/, src/, web/, admin/, shared/ and scripts/
-- returns only the DDL and two READS inside the control's detail jsonb. So:
--
--   • the earner was never asked anything;
--   • escalated_at, the column that says "this one is real", stayed null forever;
--   • every forgotten tap became a CRITICAL finding that paged the on-call within
--     the hour — the exact wolf-crying the design memo says will get the real page
--     ignored;
--   • and web/app/s/[token]/page.tsx told the friend watching the share link that
--     "GoHustlr checks in with them automatically when a gig runs long", which was
--     false.
--
-- This builds stage one and makes stage two mean something.
--
-- run_safety_checkin_stages() runs at the top of the hourly sweep, BEFORE
-- run_all_controls, so a check-in that has just come due is nudged in the same sweep
-- that would previously have paged for it:
--
--   stage 1  overdue, not yet nudged, earner has not tapped done
--            → an Alerts-inbox notification to the EARNER with fixed wording, and
--              nudged_at stamped. The UPDATE is the claim (RETURNING drives the
--              insert), so two overlapping sweeps cannot nudge the same person twice.
--   stage 2  nudged at least 30 minutes ago and still open → escalated_at stamped.
--
-- ctl_safety_checkin_overdue then fires on escalated_at, i.e. on an unanswered nudge
-- rather than on a missing tap.
--
-- ⚠️ THE BACKSTOP IS NOT OPTIONAL. Gating a safety control on a column that some other
-- function has to write means that if the writer stops running, the control goes
-- silent — and a safety control that reports nothing looks exactly like a platform
-- where nobody is in trouble. So the control ALSO fires on any open check-in more than
-- 3 hours past due regardless of what stage it reached. A broken nudge can delay the
-- page; it cannot cancel it.
--
-- Delivery is the in-app Alerts inbox, not push. Push from the database has no rail
-- today: send-push authenticates a signed-in USER's token (supabase.auth.getUser), so
-- reaching it from pg_cron would mean either putting the service-role key in a table
-- or duplicating the Expo fan-out inside controls-alert. Both are decisions bigger
-- than this fix, and neither is needed for the two-stage behaviour to become true.
-- The share-page copy is corrected in the same change to say what actually happens.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.run_safety_checkin_stages()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_nudged int := 0;
  n_escalated int := 0;
begin
  -- ── Stage 1: ask the person ────────────────────────────────────────────────
  -- The UPDATE claims the row and RETURNING feeds the notification insert, so the
  -- stamp and the message cannot come apart: no nudged_at without an alert, and no
  -- second alert for a row already claimed.
  with claimed as (
    update public.safety_checkins c
       set nudged_at = now()
      from public.bookings b
      join public.jobs j on j.id = b.job_id
     where b.id = c.booking_id
       and c.resolved_at is null
       and c.nudged_at is null
       and c.due_at < now()
       and b.status not in ('completed', 'verified', 'cancelled', 'declined')
       and not coalesce(b.earner_done, false)
    returning c.booking_id, b.earner_id, b.job_id, j.title
  ), noted as (
    insert into public.notifications (user_id, type, title, body, job_id)
    select earner_id,
           'safety_checkin',
           'Still working?',
           'Tap "done" on ' || coalesce(title, 'your gig')
             || ' when you have finished — or use Get help if something is wrong.',
           job_id
      from claimed
    returning 1
  )
  select count(*) into n_nudged from claimed;

  -- ── Stage 2: nobody answered ───────────────────────────────────────────────
  -- 30 minutes is the floor, not the cadence: the sweep runs hourly, so in practice
  -- an unanswered nudge escalates on the following sweep.
  update public.safety_checkins c
     set escalated_at = now()
    from public.bookings b
   where b.id = c.booking_id
     and c.resolved_at is null
     and c.escalated_at is null
     and c.nudged_at is not null
     and c.nudged_at < now() - interval '30 minutes'
     and b.status not in ('completed', 'verified', 'cancelled', 'declined')
     and not coalesce(b.earner_done, false);
  get diagnostics n_escalated = row_count;

  return jsonb_build_object('nudged', n_nudged, 'escalated', n_escalated);
end;
$$;

revoke execute on function public.run_safety_checkin_stages() from public, anon, authenticated;
grant execute on function public.run_safety_checkin_stages() to service_role;


-- ── The control now fires on an UNANSWERED nudge, with a hard backstop ──────
-- Body reproduced from 20260905002100 (which added the exact address) with only the
-- stage predicate added — the earner_done clause from 20260806230000 and the LEFT join
-- to job_locations are preserved exactly.
create or replace function public.ctl_safety_checkin_overdue()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.booking_id::text,
         jsonb_build_object(
           'earner_id', b.earner_id,
           'poster_id', j.poster_id,
           'job_title', j.title,
           'location', j.location,
           'exact_location', l.exact_location,
           'started_at', b.started_at,
           'due_at', c.due_at,
           'hours_overdue', round(extract(epoch from now() - c.due_at) / 3600.0, 1),
           'nudged', c.nudged_at is not null,
           'nudged_at', c.nudged_at,
           'escalated_at', c.escalated_at,
           -- Says which of the two doors this row came through, so an on-call reading
           -- the finding knows whether the worker was ever actually asked.
           'stage', case when c.escalated_at is not null then 'nudge_unanswered'
                         else 'no_nudge_was_sent' end,
           'booking_status', b.status)
    from public.safety_checkins c
    join public.bookings b on b.id = c.booking_id
    join public.jobs j     on j.id = b.job_id
    left join public.job_locations l on l.job_id = j.id
   where c.resolved_at is null
     and c.due_at < now()
     and b.status not in ('completed', 'verified', 'cancelled', 'declined')
     -- The earner said they were done. Waiting on the POSTER is not a safety event.
     and not coalesce(b.earner_done, false)
     and (
       -- An unanswered nudge: the person was asked and did not act.
       c.escalated_at is not null
       -- BACKSTOP. If the nudge stage stops running, this control must not go quiet —
       -- silence on a safety board is indistinguishable from safety.
       or c.due_at < now() - interval '3 hours'
     )
$$;

revoke execute on function public.ctl_safety_checkin_overdue() from public, anon, authenticated;


-- ── The sweep calls it, or it is a function with no caller ─────────────────
-- Reproduced from 20260814070000 with ONE step added, first, before run_all_controls:
-- a check-in that has just come due gets its nudge in the same sweep that would
-- otherwise have paged for it.
create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg jsonb; on_ boolean; url text; secret text; base text;
begin
  -- Stage one of the safety check-in, and stage two for anything that ignored it.
  -- First, so the page that follows means "we asked and got nothing back".
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


-- ── Prove the earner is asked BEFORE anyone is paged, and that silence still pages ──
do $$
declare
  uid uuid; jid uuid; bid uuid; d jsonb; n int; res jsonb; body text;
  note_count int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'checkin nudge probe', 'Odd Jobs', 100, 'flat', 'Probeville, TX', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'confirmed')
  returning id into bid;
  update public.bookings set started_at = now() - interval '4 hours' where id = bid;
  if not exists (select 1 from public.safety_checkins where booking_id = bid) then
    raise exception 'staging is wrong: starting work did not open a check-in';
  end if;
  -- Just come due: 20 minutes over, which is inside the 3-hour backstop.
  update public.safety_checkins set due_at = now() - interval '20 minutes' where booking_id = bid;

  -- BEFORE: this is the state that used to page a human within the hour.
  select count(*) into n from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if n <> 0 then
    raise exception 'FIX FAILED: a freshly-overdue gig still pages before anyone asked the worker (% rows)', n;
  end if;
  raise notice 'a forgotten tap no longer pages the on-call on its own';

  -- Stage one: the person is asked.
  select public.run_safety_checkin_stages() into res;
  if coalesce((res->>'nudged')::int, 0) < 1 then
    raise exception 'FIX FAILED: nothing was nudged (%)' , res;
  end if;
  if (select nudged_at from public.safety_checkins where booking_id = bid) is null then
    raise exception 'FIX FAILED: nudged_at is still null — the column nothing ever wrote';
  end if;
  select count(*) into note_count
    from public.notifications
   where user_id = uid and type = 'safety_checkin' and job_id = jid;
  if note_count <> 1 then
    raise exception 'FIX FAILED: the earner got % alerts, not 1', note_count;
  end if;
  raise notice 'stage one asked the worker and stamped nudged_at';

  -- Running again must not nudge the same person twice.
  select public.run_safety_checkin_stages() into res;
  select count(*) into note_count
    from public.notifications where user_id = uid and type = 'safety_checkin' and job_id = jid;
  if note_count <> 1 then
    raise exception 'the sweep re-nudges every hour: % alerts after two runs', note_count;
  end if;
  raise notice 'a second sweep does not re-ask, so this cannot become its own noise';

  -- Still inside the escalation window: nobody is paged yet.
  select count(*) into n from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if n <> 0 then
    raise exception 'paged while the nudge was still fresh (% rows)', n;
  end if;

  -- Stage two: the nudge went unanswered.
  update public.safety_checkins set nudged_at = now() - interval '40 minutes' where booking_id = bid;
  select public.run_safety_checkin_stages() into res;
  if (select escalated_at from public.safety_checkins where booking_id = bid) is null then
    raise exception 'FIX FAILED: escalated_at is still null after an unanswered nudge';
  end if;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'FIX FAILED: an unanswered nudge does not page anyone';
  end if;
  if d->>'stage' <> 'nudge_unanswered' then
    raise exception 'the finding does not say the worker was asked (stage=%)', d->>'stage';
  end if;
  raise notice 'an unanswered nudge pages, and the finding says the worker was asked';

  -- THE BACKSTOP: with the stages never run at all, a badly overdue worker must still
  -- reach the board. Otherwise this change would trade false pages for silence.
  update public.safety_checkins
     set nudged_at = null, escalated_at = null, due_at = now() - interval '5 hours'
   where booking_id = bid;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'FIX FAILED: a 5-hour overdue worker is invisible when the nudge stage is not running';
  end if;
  if d->>'stage' <> 'no_nudge_was_sent' then
    raise exception 'the backstop finding does not admit that no nudge was sent (stage=%)', d->>'stage';
  end if;
  raise notice 'the backstop still pages when the nudge never ran, and says so';

  -- An earner who tapped done is never nudged and never paged.
  update public.safety_checkins
     set nudged_at = null, escalated_at = null, due_at = now() - interval '20 minutes'
   where booking_id = bid;
  update public.bookings set earner_done = true where id = bid;
  select public.run_safety_checkin_stages() into res;
  if (select nudged_at from public.safety_checkins where booking_id = bid) is not null then
    raise exception 'nudged someone who had already tapped done';
  end if;
  raise notice 'an earner who tapped done is neither asked nor escalated';

  -- And the sweep actually calls it. The nudge functions existed in the DESIGN before
  -- and had no caller, which is the whole finding.
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'controls_sweep_and_page';
  if body not like '%run_safety_checkin_stages%' then
    raise exception 'FIX FAILED: the sweep does not call the nudge stages';
  end if;
  if body not like '%run_all_controls%' then
    raise exception 'the sweep lost run_all_controls in the rewrite';
  end if;
  raise notice 'the hourly sweep runs the stages, before the controls that page';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'checkin-nudge probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
