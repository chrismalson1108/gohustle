-- ─────────────────────────────────────────────────────────────────────────────
-- Two loose ends from the cleanup.
--
-- 1. The last schedule-anchor finding is a booking from 2026-06-11 whose slot is
--    labelled "Fri Jun 12, 10:00 AM" but carries no starts_at. That is not a data
--    corruption — the column did not exist yet. The earliest non-null starts_at in
--    either bookings or job_slots is 2026-06-30, the same day escrow launched.
--
--    The label cannot be backfilled honestly: "Fri Jun 12, 10:00 AM" has no year and
--    no timezone, so writing a timestamp would mean inventing one, on a booking that
--    is already completed and settled. Scoping is the truthful option; fabricating an
--    anchor to turn a control green is the one thing worse than leaving it red.
--
-- 2. expire_stale_pending_bookings ran once inside the last migration. A one-shot
--    repair does not stop the problem recurring, so it joins the hourly sweep next to
--    vest_bonuses.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_live_booking_without_schedule_anchor()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'reason', case
             when b.slot_id is null then 'no_slot_id'
             when s.id is null then 'slot_missing'
             when s.job_id <> b.job_id then 'slot_belongs_to_other_job'
             else 'slot_has_no_starts_at' end,
           'booking_status', b.status,
           'slot_id', b.slot_id,
           'slot_label', s.label,
           'job_id', b.job_id,
           'earner_id', b.earner_id,
           'created_at', b.created_at,
           'note', 'a live booking with no settlement anchor — flexible slots are '
                   'excluded because they carry no start time by design')
    from public.bookings b
    left join public.job_slots s on s.id = b.slot_id
   -- starts_at did not exist before this date; see header.
   where b.created_at >= timestamptz '2026-06-30'
     and b.starts_at is null
     and (b.slot_id is null
          or s.id is null
          or s.job_id <> b.job_id
          or (s.starts_at is null
              and coalesce(s.label, '') <> 'Flexible — Contact to Schedule'))
$$;

revoke execute on function public.ctl_live_booking_without_schedule_anchor() from public, anon, authenticated;

-- ── Make the expiry recurring ───────────────────────────────────────────────
-- Reproduced from the LIVE pg_proc body with one call added. Everything else,
-- including the 120s reconciliation timeout, is unchanged.
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

  -- Abandoned booking requests. A poster who never answers leaves the earner waiting
  -- and the slot flagged taken, so nobody else can book that hour either. Only
  -- untouched requests with no live authorization are expired — see the function.
  -- Wrapped so a failure here can never stop the sweep that follows it; the controls
  -- are the more important half of this job.
  begin
    perform public.expire_stale_pending_bookings(14);
  exception when others then
    raise warning 'stale pending expiry failed: %', sqlerrm;
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
      body    := jsonb_build_object('mode', 'page'),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$function$;

do $$
declare n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.run_all_controls();
  select count(*) into n from public.control_findings where resolved_at is null;
  raise notice 'open findings after scoping: %', n;
end $$;
