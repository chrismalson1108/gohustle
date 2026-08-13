-- ─────────────────────────────────────────────────────────────────────────────
-- A replayed payout event could tell an earner their money had un-arrived.
--
-- stripe-webhook upserts every payout.* event onto payout_id with no ordering guard,
-- and Stripe does not guarantee webhook delivery order — it says so explicitly, and it
-- redelivers on any non-2xx, which our own function returns whenever Supabase blips.
--
-- So this is not exotic:
--
--   payout.paid     arrives → status 'paid',    arrival_date actual, earner notified
--                             "Your $54.00 payout landed"
--   payout.created  redelivered → status 'pending', arrival_date back to the ESTIMATE
--
-- The earner has a notification saying the money arrived and a Transactions screen
-- saying it is still pending. They contact support, and support looks at the same wrong
-- row. Worse, arrival_date has silently reverted from the real date to the estimate —
-- which is the exact thing commit 2cf1fa8 changed the feature to stop doing.
--
-- Fixed now because stripe_payouts is EMPTY (0 rows, verified): there is no backfill to
-- reason about, and no earner whose row would change under them. After the first real
-- payout that stops being true.
--
-- ── TWO GUARDS, BECAUSE ONE IS NOT ENOUGH ───────────────────────────────────
--
-- 1. Event timestamp. The authoritative ordering is Stripe's `event.created`, which the
--    handler now stores. A strictly older event is ignored outright.
--
-- 2. Status monotonicity, for the case timestamps cannot decide: two events in the SAME
--    second (payout.created and payout.updated commonly are), or a legacy row with no
--    timestamp yet. A settled payout must never fall back to pending/in_transit.
--
--    Deliberately NOT a total ordering: paid → failed IS legitimate. A bank can reject a
--    payout after Stripe has marked it paid, and refusing that transition would leave us
--    telling someone their money arrived when it bounced. Only regression OUT of a
--    settled state into an unsettled one is a replay.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.stripe_payouts
  add column if not exists last_event_at timestamptz;

comment on column public.stripe_payouts.last_event_at is
  'Stripe event.created for the most recent event applied to this row. The ordering key '
  'for out-of-order/redelivered webhooks — see guard_stripe_payout_ordering.';

-- pending(1) · in_transit(2) · settled(3): paid / failed / canceled
create or replace function public.payout_status_rank(s text)
returns int
language sql
immutable
set search_path = public
as $$
  select case s
           when 'pending'    then 1
           when 'in_transit' then 2
           when 'paid'       then 3
           when 'failed'     then 3
           when 'canceled'   then 3
           else 0
         end
$$;

create or replace function public.guard_stripe_payout_ordering()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ── Guard 1: a strictly older event is a replay. Drop it whole. ───────────
  -- Returning OLD from a BEFORE UPDATE makes the write a no-op rather than an error:
  -- a redelivery is not a failure, it is Stripe doing exactly what it promises.
  if new.last_event_at is not null
     and old.last_event_at is not null
     and new.last_event_at < old.last_event_at then
    return old;
  end if;

  -- ── Guard 2: same second, or ordering unknown. Do not un-settle. ──────────
  if public.payout_status_rank(old.status) = 3
     and public.payout_status_rank(new.status) < 3 then
    new.status := old.status;
    -- The real arrival date outranks a re-sent estimate.
    new.arrival_date   := coalesce(old.arrival_date, new.arrival_date);
    new.failure_code   := coalesce(new.failure_code, old.failure_code);
    new.failure_message := coalesce(new.failure_message, old.failure_message);
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_stripe_payout_ordering() from public, anon, authenticated;

drop trigger if exists trg_z_guard_stripe_payout_ordering on public.stripe_payouts;
create trigger trg_z_guard_stripe_payout_ordering
  before update on public.stripe_payouts
  for each row execute function public.guard_stripe_payout_ordering();

-- ── Prove it discriminates: broken vs fixed on the same staged row ──────────
do $$
declare
  t0 timestamptz := now();
  got_status text;
  got_arrival timestamptz;
  real_arrival timestamptz := t0 + interval '2 days';
  est_arrival  timestamptz := t0 + interval '5 days';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- payout.paid lands first, carrying the REAL arrival date.
  insert into public.stripe_payouts
    (payout_id, account_id, amount_cents, currency, status, arrival_date, last_event_at)
  values ('po_ordering_probe', 'acct_probe', 5400, 'usd', 'paid', real_arrival, t0);

  -- payout.created is then REDELIVERED: older event, pending, estimated arrival.
  update public.stripe_payouts
     set status = 'pending', arrival_date = est_arrival,
         last_event_at = t0 - interval '1 minute'
   where payout_id = 'po_ordering_probe';

  select status, arrival_date into got_status, got_arrival
    from public.stripe_payouts where payout_id = 'po_ordering_probe';

  if got_status <> 'paid' then
    raise exception 'ORDERING GUARD FAILED: a replayed payout.created reverted status to %', got_status;
  end if;
  if got_arrival <> real_arrival then
    raise exception 'ORDERING GUARD FAILED: arrival_date reverted to the estimate';
  end if;
  raise notice 'guard 1 ok — replayed older event ignored (status=%, arrival kept)', got_status;

  -- Same-second case: no timestamp advantage, must still not un-settle.
  update public.stripe_payouts
     set status = 'pending', last_event_at = t0
   where payout_id = 'po_ordering_probe';
  select status into got_status from public.stripe_payouts where payout_id = 'po_ordering_probe';
  if got_status <> 'paid' then
    raise exception 'ORDERING GUARD FAILED: same-second replay un-settled the payout';
  end if;
  raise notice 'guard 2 ok — same-second replay could not un-settle';

  -- A LEGITIMATE later transition must still be allowed: a bank rejecting after paid.
  update public.stripe_payouts
     set status = 'failed', failure_code = 'account_closed',
         last_event_at = t0 + interval '1 hour'
   where payout_id = 'po_ordering_probe';
  select status into got_status from public.stripe_payouts where payout_id = 'po_ordering_probe';
  if got_status <> 'failed' then
    raise exception 'OVER-BLOCKING: a genuine paid->failed transition was refused (status=%)', got_status;
  end if;
  raise notice 'not over-blocking — genuine paid->failed still applies';

  -- Leave nothing behind. The table is meant to be empty until a real payout.
  delete from public.stripe_payouts where payout_id = 'po_ordering_probe';
end $$;

-- ── Notice if a row is ever internally inconsistent ─────────────────────────
create or replace function public.ctl_payout_status_regressed()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.payout_id,
         jsonb_build_object(
           'status', p.status,
           'arrival_date', p.arrival_date,
           'last_event_at', p.last_event_at,
           'user_id', p.user_id,
           'note', 'a settled payout carries no arrival date, or a payout row has no '
                   'event timestamp — either means the ordering guard is not receiving '
                   'what it needs and a replay could un-settle this row')
    from public.stripe_payouts p
   where (public.payout_status_rank(p.status) = 3 and p.status = 'paid' and p.arrival_date is null)
      or p.last_event_at is null
$$;

revoke execute on function public.ctl_payout_status_regressed() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('payout_status_regressed',
   'A payout row is missing the data its ordering guard depends on',
   'medium', 'money',
   'Stripe does not guarantee webhook delivery order and redelivers on any non-2xx. '
   'guard_stripe_payout_ordering stops a replayed payout.created from reverting a paid '
   'payout to pending, but only if last_event_at is being written. A row without it is '
   'a row where an earner can be told their money un-arrived.',
   'ctl_payout_status_regressed')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
