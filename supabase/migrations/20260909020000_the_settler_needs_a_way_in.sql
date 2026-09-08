-- ─────────────────────────────────────────────────────────────────────────────
-- The settler needs a way in, and the sweep needs to call it (2026-09-09).
--
-- 20260909010000 made a poster's reduction a PROPOSAL and put the outcome rule in
-- public.dispute_settlement_pct(disputes). Two things were missing to make it move
-- money:
--
--   1. That function takes a ROW type, which PostgREST cannot call. The settler needs
--      to ask "what is dispute X owed?" by id.
--   2. Nothing called the settler at all. A held payment with no settler is the worst
--      state this design can produce — the authorization lapses at about seven days and
--      the earner is paid NOTHING — which is exactly why ctl_dispute_settlement_overdue
--      is registered CRITICAL.
--
-- The dispatch goes in controls_sweep_and_page rather than a new cron entry, for the
-- reason 20260814070000 records: ctl_cron_not_scheduled watches only
-- array['controls_sweep','controls_digest'], so a third job could stop silently and no
-- control would notice.
--
-- The body below is copied forward from LIVE pg_get_functiondef with exactly one block
-- added. That distinction is load-bearing: 20260906034000 rebuilt this function from an
-- older FILE and silently dropped run_safety_checkin_stages, which 20260906053000 then
-- had to restore. The probe asserts every step survives.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Ask the outcome by id ───────────────────────────────────────────────────
-- A thin wrapper, deliberately: the RULE stays in dispute_settlement_pct and this only
-- resolves the row. Granted to service_role ONLY — the settler is the caller, and an
-- authenticated user asking "what is this dispute owed?" would be reading a decision
-- before either party has been told it.
create or replace function public.dispute_due_pct(p_dispute uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select public.dispute_settlement_pct(d.*) from public.disputes d where d.id = p_dispute;
$$;

revoke execute on function public.dispute_due_pct(uuid) from public, anon, authenticated;
grant execute on function public.dispute_due_pct(uuid) to service_role;

-- ── The sweep, copied forward from live with one step added ──────────────────
CREATE OR REPLACE FUNCTION public.controls_sweep_and_page()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Waitlist retention. The migration that created the table PROMISES two rules in its
  -- own comments and in the published Privacy Policy — attempts cleared at 48 hours,
  -- unconfirmed rows expired at 180 days — and shipped the function with no caller at
  -- all, which is the exact shape 20260814070000 exists to record for the assistant
  -- purge above. Wrapped like every other step: a failed purge must not stop the sweep
  -- reaching run_all_controls().
  begin
    perform public.purge_waitlist_expired();
  exception when others then
    raise warning 'waitlist purge failed: %', sqlerrm;
  end;

  -- Pay out every dispute whose outcome is decided. Dispatched over HTTP because the
  -- settlement is a Stripe capture and Postgres cannot make one; the same net.http_post
  -- rail, the same shared secret, as reconcile-stripe below.
  --
  -- BEFORE run_all_controls, deliberately: ctl_dispute_settlement_overdue reads the
  -- state this call produces, so running it first means the board reflects this sweep
  -- rather than the last one. Wrapped like every other step — a failed settlement must
  -- not stop the sweep reaching the controls that would report it.
  begin
    cfg    := public.alert_config('controls_alert');
    url    := nullif(cfg->>'url', '');
    secret := coalesce(cfg->>'secret', '');
    if url is not null then
      perform net.http_post(
        url     := regexp_replace(url, '/controls-alert$', '') || '/settle-disputes',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
        body    := jsonb_build_object('source', 'sweep'),
        timeout_milliseconds := 120000
      );
    end if;
  exception when others then
    raise warning 'dispute settlement dispatch failed: %', sqlerrm;
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
$function$
;


-- ── Probe ───────────────────────────────────────────────────────────────────
do $$
declare
  def  text;
  step text;
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid; due int;
begin
  select pg_get_functiondef(oid) into def from pg_proc
   where proname = 'controls_sweep_and_page' and pronamespace = 'public'::regnamespace;

  -- Every step the live body carried BEFORE this migration, plus the new one.
  foreach step in array array[
    'run_safety_checkin_stages',
    'vest_bonuses',
    'expire_stale_pending_bookings',
    'expire_dead_listings',
    'purge_assistant_pending_actions',
    'purge_waitlist_expired',
    'settle-disputes',
    'run_all_controls',
    'set_config'
  ] loop
    if position(step in def) = 0 then
      raise exception 'FIX FAILED: the sweep lost %', step;
    end if;
  end loop;
  -- Order matters: the settler runs BEFORE the controls that report on it. Anchored on
  -- the STATEMENT, not the bare name — the waitlist purge's own comment (20260908020000)
  -- says "reaching run_all_controls()" earlier in the body, and matching that made this
  -- check compare a dispatch against a sentence.
  if position('/settle-disputes''' in def) > position('perform public.run_all_controls();' in def) then
    raise exception 'FIX FAILED: the settler is dispatched after run_all_controls';
  end if;
  raise notice 'sweep dispatches settle-disputes, before run_all_controls, with all 8 other steps intact';

  -- dispute_due_pct answers by id and agrees with the row-typed function.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then
    raise notice 'probe skipped — needs two profiles';
    raise exception 'probe complete — rolling back';
  end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe settle', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_settle', now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe', 80) returning id into did;

  select public.dispute_due_pct(did) into due;
  if due is not null then raise exception 'FIX FAILED: a fresh dispute is already due (%)', due; end if;
  update public.disputes set settle_after = now() - interval '1 minute' where id = did;
  select public.dispute_due_pct(did) into due;
  if due <> 80 then raise exception 'FIX FAILED: dispute_due_pct returned % for a lapsed window, expected 80', due; end if;
  raise notice 'dispute_due_pct discriminates by id';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'settler probe passed — all changes rolled back';
  else
    raise;
  end if;
end $$;
