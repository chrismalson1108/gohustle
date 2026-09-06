-- ─────────────────────────────────────────────────────────────────────────────
-- The hourly sweep cannot cancel a stale application, because it carries no JWT —
-- and it swallows the error that says so.
--
-- ── THE MECHANISM ───────────────────────────────────────────────────────────
-- `controls_sweep_and_page` (final definition 20260814070000:38-43) does:
--
--     begin
--       perform public.expire_stale_pending_bookings(14);
--     exception when others then
--       raise warning 'stale pending expiry failed: %', sqlerrm;
--     end;
--
-- and sets no claims anywhere in its body. `expire_stale_pending_bookings`
-- (20260812080000:105-137) is a plain `update public.bookings set status = 'cancelled'`,
-- so it fires `trg_guard_bookings_write`. The final guard (20260730140000:40-183)
-- exempts exactly one caller — `if coalesce(auth.role(), '') = 'service_role' then
-- return new` at :49 — and otherwise routes an UPDATE through the poster branch
-- (`auth.uid() = poster`) or the earner branch (`auth.uid() = old.earner_id`), falling
-- through to `raise exception 'not authorized to modify this booking'` at :182.
--
-- pg_cron runs `select public.controls_sweep_and_page()` (20260806030000:108) with no
-- request.jwt.claims GUC set at all, so `auth.role()` and `auth.uid()` are both NULL.
-- The FIRST qualifying booking hits the deny-by-default raise, the whole UPDATE rolls
-- back, and the sweep's own `exception when others` turns that into a warning in a log
-- nobody reads. The expiry has therefore never once run on schedule.
--
-- ── WHY NOBODY NOTICED ──────────────────────────────────────────────────────
-- The only callers that ever succeeded set the claim for their own transaction first:
-- 20260812080000:20 does it explicitly with a comment saying the guards require it, and
-- the probe in 20260813060000:215 does the same before calling expire_dead_listings. The
-- authors knew. The scheduled caller — the only one that runs more than once — never got
-- the line. And the console's "Run sweep now" does NOT cover for it: `runSweepNow`
-- (admin/app/(console)/controls/actions.ts:86) calls `run_all_controls`, which never
-- touches the expiry, so pg_cron is the sole production caller.
--
-- ── WHAT IT COSTS ───────────────────────────────────────────────────────────
-- OPEN_WORK's poster-discount row names `expire_stale_pending_bookings(14)` as the
-- backstop that eventually releases a campaign benefit consumed by an application nobody
-- accepted. That backstop does not fire. A stranger's ignored application therefore keeps
-- the poster's discount use and the campaign budget consumed indefinitely, keeps the slot
-- flagged taken (bookings_one_active_per_slot counts 'pending' as live), and leaves the
-- earner waiting under Awaiting forever.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- 1. Claim service_role for the sweep's own transaction, at the top, once — the same
--    transaction-local idiom 20260812080000 already uses, and visible at the point of
--    use rather than hidden inside a helper. It is not an escalation: the sweep is
--    already SECURITY DEFINER and is revoked from public/anon/authenticated, so the only
--    callers are service_role and the owner. What the line changes is that the guards can
--    now RECOGNISE the privileged caller they were always meant to exempt.
--    Body otherwise copied verbatim from 20260814070000. Nothing else changes.
--
-- 2. A control for the failure MODE, because a warning is not a signal.
--    `ctl_expiry_sweep_not_clearing` returns exactly the set the sweep is supposed to
--    have emptied — pending, past the window, never started, no live hold. If the sweep
--    runs, this is empty by construction. If it is silently failing again for any reason,
--    the rows open a finding instead of a log line. ctl_stranded_pending_booking cannot
--    do this job: it deliberately also matches rows the expiry must NOT touch (a booking
--    with started_at set, or with a live Stripe authorization), so it can never be zero
--    on a healthy system and can never mean "the sweep is broken".
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


-- ── The control: the set the sweep should have emptied and did not ──────────
--
-- The predicate is the expiry's own WHERE clause, one day looser. 14 days is when a row
-- becomes eligible; the sweep runs at :05 every hour, so a row that is still here at 15
-- days has survived at least twenty-four consecutive sweeps. That margin is what stops
-- this being a race against the cadence and makes any row it returns mean one thing:
-- the expiry did not do its job.
create or replace function public.ctl_expiry_sweep_not_clearing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$
  select b.id::text as entity_id,
         jsonb_build_object(
           'job_id', b.job_id::text,
           'job_title', j.title,
           'poster_id', j.poster_id::text,
           'earner_id', b.earner_id::text,
           'slot_id', b.slot_id::text,
           'created_at', b.created_at,
           'days_open', floor(extract(epoch from now() - b.created_at) / 86400),
           'holds_benefit', exists (select 1 from public.promo_redemptions r
                                     where r.booking_id = b.id
                                       and r.released_at is null
                                       and r.settled_at is null),
           'note', 'this booking matches expire_stale_pending_bookings(14) exactly and '
                   'has outlived the window by more than a day, so the hourly sweep has '
                   'had at least 24 chances to cancel it and has not. The sweep wraps '
                   'that call in `exception when others then raise warning`, so a failure '
                   'is invisible unless something asserts the outcome — which is what '
                   'this control is.',
           'remedy', 'Read the postgres log for `stale pending expiry failed`. The known '
                     'cause is a caller with no request.jwt.claims: guard_bookings_write '
                     'exempts only service_role and otherwise raises on the first '
                     'qualifying row, aborting the whole UPDATE. Confirm the live '
                     'controls_sweep_and_page still sets that claim before the call.'
         ) as detail
    from public.bookings b
    join public.jobs j on j.id = b.job_id
   where b.status = 'pending'
     and b.created_at < now() - interval '15 days'
     -- Nobody ever started it. A pending booking WITH started_at is a real disagreement
     -- the expiry deliberately refuses to tidy away, so it is not this control's row.
     and b.started_at is null
     -- No live hold. Money at Stripe is a human's job and the expiry skips it on purpose.
     and not exists (select 1 from public.payments p
                      where p.booking_id = b.id and p.status = 'authorized')
$ctl$;

revoke execute on function public.ctl_expiry_sweep_not_clearing() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('expiry_sweep_not_clearing',
   'Stale application the hourly expiry should have cancelled and has not',
   'medium', 'lifecycle',
   'controls_sweep_and_page calls expire_stale_pending_bookings(14) inside `exception '
   'when others then raise warning`, so every failure of that call is a log line nobody '
   'reads. It failed from the day it was scheduled: pg_cron sets no request.jwt.claims, '
   'and guard_bookings_write exempts only service_role before ending in `raise exception '
   '''not authorized to modify this booking''` — so the first qualifying row aborted the '
   'whole UPDATE, every hour, silently. This control asserts the OUTCOME instead of the '
   'call: it returns exactly the rows the expiry matches (pending, never started, no live '
   'authorization) that have outlived the 14-day window by more than a day, i.e. survived '
   'at least 24 sweeps. Zero on a healthy system by construction. Not covered by '
   'stranded_pending_booking, which deliberately also matches rows the expiry must never '
   'touch and therefore can never mean "the sweep is broken". Each row costs something '
   'real: the slot stays flagged taken and unbookable, the earner waits under Awaiting '
   'forever, and any campaign benefit the application consumed at INSERT stays consumed.',
   'ctl_expiry_sweep_not_clearing')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it: same staged row, broken vs fixed, then rolled back ────────────
do $$
declare
  uid uuid; jid uuid; bid uuid;
  st text; n int; blocked boolean; errm text; body text;
  pos_claim int; pos_expire int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'sweep claim probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- An application nobody ever answered: pending, never started, no hold. This is
  -- precisely the shape expire_stale_pending_bookings(14) exists to cancel.
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'pending')
  returning id into bid;
  update public.bookings set created_at = now() - interval '20 days' where id = bid;

  -- ── THE BROKEN HALF ──────────────────────────────────────────────────────
  -- Blank the claim: this is pg_cron, which sets none at all. auth.role() and auth.uid()
  -- both resolve to NULL, so the guard's deny-by-default raise is what the expiry meets.
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.expire_stale_pending_bookings(14);
    blocked := false;
  exception when others then
    blocked := true; errm := sqlerrm;
  end;
  if not blocked then
    raise exception 'NOT A DEFECT: the expiry succeeded with no claims, so the guard is not what stops it';
  end if;
  if errm not like '%not authorized to modify this booking%' then
    raise exception 'blocked, but by something else: %', errm;
  end if;
  raise notice 'claim-less caller (i.e. pg_cron): the expiry raises "%" and cancels nothing', errm;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select status into st from public.bookings where id = bid;
  if st <> 'pending' then
    raise exception 'expected the application to survive the failed sweep, found %', st;
  end if;

  -- And the new control sees exactly that stuck row.
  select count(*) into n from public.ctl_expiry_sweep_not_clearing() where entity_id = bid::text;
  if n <> 1 then
    raise exception 'FIX FAILED: the control reported % rows for a 20-day stuck application', n;
  end if;
  raise notice 'the control names the stuck application, so a silent sweep failure opens a finding';

  -- ── THE FIXED HALF — same row ────────────────────────────────────────────
  -- With the claim the sweep now sets, the identical call cancels it.
  perform public.expire_stale_pending_bookings(14);
  select status into st from public.bookings where id = bid;
  if st <> 'cancelled' then
    raise exception 'FIX FAILED: with the service_role claim the expiry left the booking at %', st;
  end if;
  raise notice 'with the claim the sweep now sets, the identical call cancels it';

  select count(*) into n from public.ctl_expiry_sweep_not_clearing() where entity_id = bid::text;
  if n <> 0 then
    raise exception 'the finding did not auto-resolve once the row was cancelled (% rows)', n;
  end if;
  raise notice 'and the finding resolves rather than accumulating';

  -- ── The sweep is what must carry the claim ───────────────────────────────
  -- Asserting on the source is the point: the expiry was correct all along and simply
  -- had a caller that could not use it, which no amount of testing the expiry reveals.
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public' and p.proname = 'controls_sweep_and_page';
  pos_claim  := position('request.jwt.claims' in body);
  pos_expire := position('expire_stale_pending_bookings' in body);
  if pos_claim = 0 then
    raise exception 'FIX FAILED: the sweep still sets no request.jwt.claims';
  end if;
  if pos_expire = 0 then
    raise exception 'the sweep no longer calls the expiry at all';
  end if;
  if pos_claim > pos_expire then
    raise exception 'FIX FAILED: the sweep sets the claim AFTER the expiry it is meant to authorize';
  end if;
  raise notice 'the scheduled caller claims service_role before it reaches the expiry';

  if not exists (select 1 from public.controls
                  where key = 'expiry_sweep_not_clearing' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'sweep-claim probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
