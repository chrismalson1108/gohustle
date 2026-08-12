-- ─────────────────────────────────────────────────────────────────────────────
-- The control library: 16 invariant checks (2026-08-06).
--
-- GENERATED from the verified control set — do not hand-edit the function bodies;
-- change the source and regenerate, the same rule as the categories seed.
--
-- Every control here was executed against the live database before being registered:
-- it runs without error and returns the (entity_id text, detail jsonb) shape
-- run_control() requires. That mattered more than usual — the discovery run flagged
-- that its own agents had shared a scratchpad and could have crossed results, so each
-- of these was independently re-run and the counts reproduced exactly before landing.
--
-- SIX FIRE ON TODAY'S DATA. That is intentional and they are not false positives —
-- they are real anomalies in pre-beta test data, and suppressing them would mean
-- shipping controls that have never been seen to work:
--   escrow_hold_lapsed_uncancelled    1  $8k hold authorized 2026-08-01, past Stripe's
--                                        ~7-day expiry, still 'authorized' in the DB
--   settled_without_captured_payment  2  bookings verified/completed 2026-06-11..13
--                                        with no payments row — predate the payment path
--   earnings_total_drift              2  profiles.earnings_total vs credited payments
--   live_booking_without_schedule_anchor 1
--   stranded_pending_booking          5
--   slot_taken_flag_drift             3
--   amendment_unlock_outlives_booking 1
-- Running PRE_LAUNCH_DATA_RESET clears the legacy rows; anything still open after that
-- is a live problem.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── earner_credit_missing  [critical/money] ─────────────────────────────
create or replace function public.ctl_earner_credit_missing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  p.id::text as entity_id,
  jsonb_build_object(
    'kind', 'escrow_capture_not_credited',
    'booking_id', p.booking_id,
    'earner_id', b.earner_id,
    'payment_intent_id', p.payment_intent_id,
    'earner_amount_cents', p.earner_amount_cents,
    'fee_cents', p.fee_cents,
    'captured_at', p.captured_at,
    'minutes_stale', round(extract(epoch from now() - coalesce(p.captured_at, p.created_at, 'epoch'::timestamptz)) / 60)::int,
    'remedy', 'service_role: select public.credit_earnings(<this payments.id>)'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
where p.status = 'captured'
  and coalesce(p.earnings_credited, false) = false
  and coalesce(p.captured_at, p.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'
union all
select
  t.id::text,
  jsonb_build_object(
    'kind', 'tip_charged_not_credited',
    'booking_id', t.booking_id,
    'earner_id', t.earner_id,
    'payment_intent_id', t.payment_intent_id,
    'amount_cents', t.amount_cents,
    'charged_at', t.created_at,
    'minutes_stale', round(extract(epoch from now() - coalesce(t.created_at, 'epoch'::timestamptz)) / 60)::int,
    'remedy', 'service_role: select public.claim_and_credit_tip(payment_intent_id, booking_id, earner_id, amount_cents) — or refund the PaymentIntent in Stripe'
  )
from public.tip_ledger t
where coalesce(t.credited, false) = false
  and coalesce(t.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'$ctl$;
revoke execute on function public.ctl_earner_credit_missing() from public, anon, authenticated;

-- ── payment_ledger_impossible  [critical/money] ─────────────────────────────
create or replace function public.ctl_payment_ledger_impossible()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  p.id::text as entity_id,
  jsonb_build_object(
    'violations', to_jsonb(v.kinds),
    'booking_id', p.booking_id,
    'payment_intent_id', p.payment_intent_id,
    'status', p.status,
    'authorized_cents', p.amount_cents,
    'captured_total_cents', coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0),
    'earner_amount_cents', p.earner_amount_cents,
    'fee_cents', p.fee_cents,
    'refunded_cents', coalesce(p.refunded_cents, 0),
    'refund_source', p.refund_source,
    'earnings_credited', coalesce(p.earnings_credited, false)
  ) as detail
from public.payments p
cross join lateral (
  select array_remove(array[
    case when p.status = 'captured'
          and coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0) > coalesce(p.amount_cents, 0)
         then 'captured_more_than_authorized' end,
    case when p.status = 'captured'
          and coalesce(p.refunded_cents, 0) > coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0)
         then 'refunded_more_than_captured' end,
    case when coalesce(p.refunded_cents, 0) > 0 and p.status <> 'captured'
         then 'refunded_but_never_captured' end,
    case when coalesce(p.earnings_credited, false) and p.status <> 'captured'
         then 'credited_without_capture' end,
    case when coalesce(p.amount_cents, 0) <= 0
           or coalesce(p.fee_cents, 0) < 0
           or coalesce(p.earner_amount_cents, 0) < 0
         then 'non_positive_amounts' end
  ]::text[], null) as kinds
) v
where array_length(v.kinds, 1) > 0$ctl$;
revoke execute on function public.ctl_payment_ledger_impossible() from public, anon, authenticated;

-- ── escrow_hold_lapsed_uncancelled  [critical/money] ─────────────────────────────
create or replace function public.ctl_escrow_hold_lapsed_uncancelled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  p.id::text as entity_id,
  jsonb_build_object(
    'booking_id', p.booking_id,
    'booking_status', b.status,
    'earner_id', b.earner_id,
    'earner_done', coalesce(b.earner_done, false),
    'poster_id', j.poster_id,
    'payment_intent_id', p.payment_intent_id,
    'amount_cents', p.amount_cents,
    'hold_placed_at', h.at,
    'hold_age_days', round(extract(epoch from now() - h.at) / 86400.0, 1),
    'row_created_at', p.created_at,
    'row_cancelled_at', p.cancelled_at
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join public.jobs j on j.id = b.job_id
cross join lateral (select greatest(p.created_at, p.cancelled_at) as at) h
where p.status = 'authorized'
  and h.at is not null
  and h.at < now() - interval '8 days'$ctl$;
revoke execute on function public.ctl_escrow_hold_lapsed_uncancelled() from public, anon, authenticated;

-- ── escrow_hold_expiring_work_done  [high/money] ─────────────────────────────
create or replace function public.ctl_escrow_hold_expiring_work_done()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  b.id::text as entity_id,
  jsonb_build_object(
    'payment_id', p.id,
    'payment_intent_id', p.payment_intent_id,
    'amount_cents', p.amount_cents,
    'booking_status', b.status,
    'earner_id', b.earner_id,
    'poster_id', j.poster_id,
    'job_title', j.title,
    'slot_id', b.slot_id,
    'hold_placed_at', h.at,
    'hours_until_lapse', round(extract(epoch from (h.at + interval '7 days') - now()) / 3600.0, 1),
    'earner_done', coalesce(b.earner_done, false),
    'poster_done', coalesce(b.poster_done, false)
  ) as detail
from public.bookings b
join public.payments p on p.booking_id = b.id
join public.jobs j on j.id = b.job_id
cross join lateral (select greatest(p.created_at, p.cancelled_at) as at) h
where p.status = 'authorized'
  and coalesce(b.earner_done, false)
  and b.status in ('confirmed', 'completed')
  and h.at is not null
  and h.at < now() - interval '5 days'
  and h.at >= now() - interval '8 days'$ctl$;
revoke execute on function public.ctl_escrow_hold_expiring_work_done() from public, anon, authenticated;

-- ── money_exposed_on_dead_booking  [critical/money] ─────────────────────────────
create or replace function public.ctl_money_exposed_on_dead_booking()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  b.id::text as entity_id,
  jsonb_build_object(
    'kind', case when p.status = 'captured' then 'captured_on_dead_booking' else 'hold_never_released' end,
    'booking_status', b.status,
    'payment_status', p.status,
    'payment_id', p.id,
    'payment_intent_id', p.payment_intent_id,
    'authorized_cents', p.amount_cents,
    'captured_total_cents', coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0),
    'refunded_cents', coalesce(p.refunded_cents, 0),
    'earnings_credited', coalesce(p.earnings_credited, false),
    'earner_id', b.earner_id,
    'poster_id', j.poster_id,
    'booking_created_at', b.created_at
  ) as detail
from public.bookings b
join public.payments p on p.booking_id = b.id
join public.jobs j on j.id = b.job_id
where b.status in ('declined', 'cancelled')
  and (
    (p.status = 'captured'
       and coalesce(p.refunded_cents, 0) < coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0))
    or (p.status = 'authorized'
       and coalesce(b.created_at, p.created_at, 'epoch'::timestamptz) < now() - interval '6 hours')
  )$ctl$;
revoke execute on function public.ctl_money_exposed_on_dead_booking() from public, anon, authenticated;

-- ── settled_without_captured_payment  [critical/money] ─────────────────────────────
create or replace function public.ctl_settled_without_captured_payment()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  b.id::text as entity_id,
  jsonb_build_object(
    'kind', case
              when b.status = 'verified' and p.id is null then 'verified_without_payment_row'
              when b.status = 'verified' then 'verified_payment_not_captured'
              else b.status || '_without_payment_row'
            end,
    'booking_status', b.status,
    'payment_id', p.id,
    'payment_status', p.status,
    'payment_intent_id', p.payment_intent_id,
    'earner_id', b.earner_id,
    'poster_id', j.poster_id,
    'job_title', j.title,
    'amount_cents_quoted', b.amount_cents_quoted,
    'earner_done', coalesce(b.earner_done, false),
    'poster_done', coalesce(b.poster_done, false),
    'booking_created_at', b.created_at,
    'completed_at', b.completed_at
  ) as detail
from public.bookings b
join public.jobs j on j.id = b.job_id
left join public.payments p on p.booking_id = b.id
where (b.status = 'verified' and (p.id is null or p.status <> 'captured'))
   or (b.status in ('confirmed', 'completed')
       and p.id is null
       and coalesce(b.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes')$ctl$;
revoke execute on function public.ctl_settled_without_captured_payment() from public, anon, authenticated;

-- ── earnings_total_drift  [high/money] ─────────────────────────────
create or replace function public.ctl_earnings_total_drift()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$with credited as (
  select b.earner_id as uid, sum(coalesce(p.earner_amount_cents, 0))::bigint as cents
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where coalesce(p.earnings_credited, false)
   group by b.earner_id
),
tipped as (
  select t.earner_id as uid, sum(coalesce(t.amount_cents, 0))::bigint as cents
    from public.tip_ledger t
   where coalesce(t.credited, false) and t.earner_id is not null
   group by t.earner_id
),
clawed as (
  select b.earner_id as uid,
         sum(round(coalesce(p.refunded_cents, 0)::numeric
                   * coalesce(p.earner_amount_cents, 0)
                   / nullif(coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0), 0)))::bigint as cents,
         count(*)::int as n
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where coalesce(p.refunded_cents, 0) > 0
     and coalesce(p.earnings_credited, false)
   group by b.earner_id
)
select
  pr.id::text as entity_id,
  jsonb_build_object(
    'stored_earnings_total', pr.earnings_total,
    'expected_earnings_total', e.expected,
    'delta_dollars', round(coalesce(pr.earnings_total, 0) - e.expected, 2),
    'captured_credited_cents', coalesce(c.cents, 0),
    'tips_credited_cents', coalesce(t.cents, 0),
    'refund_clawback_cents', coalesce(r.cents, 0),
    'refunded_payments', coalesce(r.n, 0),
    'tolerance_dollars', e.tol
  ) as detail
from public.profiles pr
left join credited c on c.uid = pr.id
left join tipped   t on t.uid = pr.id
left join clawed   r on r.uid = pr.id
cross join lateral (
  select
    round(greatest(0::bigint, coalesce(c.cents, 0) + coalesce(t.cents, 0) - coalesce(r.cents, 0))::numeric / 100, 2) as expected,
    round(0.02 + 0.02 * coalesce(r.n, 0), 2) as tol
) e
where abs(coalesce(pr.earnings_total, 0) - e.expected) > e.tol$ctl$;
revoke execute on function public.ctl_earnings_total_drift() from public, anon, authenticated;

-- ── external_reversal_not_ledgered  [high/money] ─────────────────────────────
create or replace function public.ctl_external_reversal_not_ledgered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$with reversal as (
  -- Only the reversal rows stripe-webhook's recordReversal() writes. Scanned once,
  -- not once per payment: disputes has no booking_id index and the reason-prefix
  -- filter cuts this to a handful of rows before anything joins to it.
  select distinct on (dd.booking_id)
         dd.booking_id,
         dd.id,
         dd.reason,
         dd.created_at,
         dd.resolved_at,
         -- charge.refunded reasons end "(usd 12.34 refunded)" and carry Stripe's
         -- CUMULATIVE charge.amount_refunded. Chargeback reasons don't match this
         -- shape, so they parse to NULL and take the refunded_cents branch below.
         round(substring(dd.reason from '([0-9]+\.[0-9]{2}) refunded\)')::numeric * 100)::bigint
           as reversal_cents
    from public.disputes dd
   where dd.reason ilike 'Stripe refund on charge%'
      or dd.reason ilike 'Stripe chargeback%'
   order by dd.booking_id, dd.created_at desc
)
select
  p.id::text as entity_id,
  jsonb_build_object(
    'booking_id', p.booking_id,
    'payment_status', p.status,
    'payment_intent_id', p.payment_intent_id,
    'authorized_cents', p.amount_cents,
    'captured_total_cents', coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0),
    'auto_released_cents', r.released_cents,
    'reversal_cents_per_stripe', d.reversal_cents,
    'refunded_cents', coalesce(p.refunded_cents, 0),
    'unledgered_cents', case when d.reversal_cents is null then null
                             else d.reversal_cents - r.released_cents - coalesce(p.refunded_cents, 0) end,
    'refund_source', p.refund_source,
    'earnings_credited', coalesce(p.earnings_credited, false),
    'earner_id', b.earner_id,
    'dispute_id', d.id,
    'dispute_reason', d.reason,
    'dispute_opened_at', d.created_at,
    'dispute_resolved_at', d.resolved_at,
    'remedy', 'admin console -> booking -> Record chargeback (or Refund), so record_refund writes refunded_cents and debits the earner'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join reversal d on d.booking_id = p.booking_id
cross join lateral (
  -- A partial capture leaves amount_cents - (earner + fee) uncaptured, and Stripe
  -- surfaces that released remainder as a refund on the charge. That is NOT a ledger
  -- gap: refunded_cents = 0 is correct for it.
  select greatest(
           coalesce(p.amount_cents, 0)
             - (coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0)),
           0) as released_cents
) r
where p.status = 'captured'
  and d.created_at < now() - interval '24 hours'
  and (
        (d.reversal_cents is null and coalesce(p.refunded_cents, 0) = 0)
        or
        (d.reversal_cents is not null
         and d.reversal_cents > r.released_cents + coalesce(p.refunded_cents, 0))
      )$ctl$;
revoke execute on function public.ctl_external_reversal_not_ledgered() from public, anon, authenticated;

-- ── booking_status_contradicts_done_flags  [medium/lifecycle] ─────────────────────────────
create or replace function public.ctl_booking_status_contradicts_done_flags()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select b.id::text as entity_id,
       jsonb_build_object(
         'status', b.status,
         'earner_done', coalesce(b.earner_done, false),
         'poster_done', coalesce(b.poster_done, false),
         'job_id', b.job_id::text,
         'earner_id', b.earner_id::text,
         'created_at', b.created_at,
         'completed_at', b.completed_at,
         'shape', case
                    when b.status in ('completed','verified') then 'advanced_without_mutual_done'
                    else 'both_done_but_never_advanced'
                  end
       ) as detail
  from public.bookings b
 where (b.status in ('completed','verified')
         and not (coalesce(b.earner_done, false) and coalesce(b.poster_done, false)))
    or (b.status = 'confirmed'
        and coalesce(b.earner_done, false)
        and coalesce(b.poster_done, false))$ctl$;
revoke execute on function public.ctl_booking_status_contradicts_done_flags() from public, anon, authenticated;

-- ── live_booking_on_dead_job  [high/lifecycle] ─────────────────────────────
create or replace function public.ctl_live_booking_on_dead_job()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select b.id::text as entity_id,
       jsonb_build_object(
         'booking_status', b.status,
         'job_status', j.status,
         'job_id', j.id::text,
         'job_title', j.title,
         'poster_id', j.poster_id::text,
         'earner_id', b.earner_id::text,
         'booking_created_at', b.created_at,
         'scheduled_for', b.starts_at,
         'earner_done', coalesce(b.earner_done, false),
         'poster_done', coalesce(b.poster_done, false)
       ) as detail
  from public.bookings b
  join public.jobs j on j.id = b.job_id
 where b.status in ('confirmed','completed')
   and j.status in ('cancelled','completed')$ctl$;
revoke execute on function public.ctl_live_booking_on_dead_job() from public, anon, authenticated;

-- ── live_booking_without_schedule_anchor  [high/lifecycle] ─────────────────────────────
create or replace function public.ctl_live_booking_without_schedule_anchor()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select b.id::text as entity_id,
       jsonb_build_object(
         'booking_status', b.status,
         'job_id', b.job_id::text,
         'earner_id', b.earner_id::text,
         'slot_id', b.slot_id::text,
         'slot_label', b.slot_label,
         'booking_starts_at', b.starts_at,
         'earner_done', coalesce(b.earner_done, false),
         'created_at', b.created_at,
         'reason', case
                     when b.slot_id is null then 'booking_has_no_slot'
                     when s.id is null then 'slot_row_missing'
                     when s.job_id <> b.job_id then 'slot_belongs_to_another_job'
                     else 'slot_has_no_starts_at'
                   end
       ) as detail
  from public.bookings b
  left join public.job_slots s on s.id = b.slot_id
 where b.status in ('confirmed','completed')
   and (b.slot_id is null
        or s.id is null
        or s.job_id <> b.job_id
        or s.starts_at is null)$ctl$;
revoke execute on function public.ctl_live_booking_without_schedule_anchor() from public, anon, authenticated;

-- ── stranded_pending_booking  [medium/lifecycle] ─────────────────────────────
create or replace function public.ctl_stranded_pending_booking()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select b.id::text as entity_id,
       jsonb_build_object(
         'job_id', b.job_id::text,
         'job_title', j.title,
         'job_status', j.status,
         'poster_id', j.poster_id::text,
         'earner_id', b.earner_id::text,
         'slot_id', b.slot_id::text,
         'slot_label', b.slot_label,
         'scheduled_for', coalesce(b.starts_at, s.starts_at),
         'created_at', b.created_at,
         'days_open', floor(extract(epoch from now() - b.created_at) / 86400),
         'reason', case
                     when coalesce(b.starts_at, s.starts_at) is not null
                       then 'scheduled_time_passed'
                     else 'unscheduled_and_aged'
                   end
       ) as detail
  from public.bookings b
  join public.jobs j on j.id = b.job_id
  left join public.job_slots s on s.id = b.slot_id
 where b.status = 'pending'
   and ((coalesce(b.starts_at, s.starts_at) is not null
         and coalesce(b.starts_at, s.starts_at) < now() - interval '1 day')
     or (coalesce(b.starts_at, s.starts_at) is null
         and b.created_at < now() - interval '14 days'))$ctl$;
revoke execute on function public.ctl_stranded_pending_booking() from public, anon, authenticated;

-- ── slot_taken_flag_drift  [low/integrity] ─────────────────────────────
create or replace function public.ctl_slot_taken_flag_drift()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select s.id::text as entity_id,
       jsonb_build_object(
         'job_id', s.job_id::text,
         'label', s.label,
         'starts_at', s.starts_at,
         'taken_flag', s.taken,
         'live_bookings', (select count(*) from public.bookings b
                            where b.slot_id = s.id
                              and b.status in ('pending','confirmed','completed','verified')),
         'direction', case when s.taken then 'flagged_taken_but_free'
                          else 'flagged_free_but_booked' end
       ) as detail
  from public.job_slots s
 where s.taken is distinct from (
         exists (select 1 from public.bookings b
                  where b.slot_id = s.id
                    and b.status in ('pending','confirmed','completed','verified'))
       )$ctl$;
revoke execute on function public.ctl_slot_taken_flag_drift() from public, anon, authenticated;

-- ── dispute_resolution_desync  [high/integrity] ─────────────────────────────
create or replace function public.ctl_dispute_resolution_desync()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select d.id::text as entity_id,
       jsonb_build_object(
         'booking_id', d.booking_id::text,
         'status', d.status,
         'resolved_at', d.resolved_at,
         'resolved_by', d.resolved_by::text,
         'assigned_to', d.assigned_to::text,
         'raised_by', d.raised_by::text,
         'created_at', d.created_at,
         'shape', case when d.status in ('resolved','rejected')
                       then 'closed_status_but_resolved_at_null_payout_still_blocked'
                       else 'resolved_at_set_but_status_still_open_dropped_from_queue'
                  end
       ) as detail
  from public.disputes d
 where (d.status in ('resolved','rejected')) is distinct from (d.resolved_at is not null)$ctl$;
revoke execute on function public.ctl_dispute_resolution_desync() from public, anon, authenticated;

-- ── dispute_open_beyond_sla  [high/lifecycle] ─────────────────────────────
create or replace function public.ctl_dispute_open_beyond_sla()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select d.id::text as entity_id,
       jsonb_build_object(
         'booking_id', d.booking_id::text,
         'booking_status', b.status,
         'job_id', b.job_id::text,
         'earner_id', b.earner_id::text,
         'dispute_status', d.status,
         'assigned_to', d.assigned_to::text,
         'raised_by', d.raised_by::text,
         'pct_paid', d.pct_paid,
         'created_at', d.created_at,
         'days_open', case when d.created_at is null then null
                      else floor(extract(epoch from now() - d.created_at) / 86400) end
       ) as detail
  from public.disputes d
  join public.bookings b on b.id = d.booking_id
 where d.resolved_at is null
   and (d.created_at is null or d.created_at < now() - interval '14 days')$ctl$;
revoke execute on function public.ctl_dispute_open_beyond_sla() from public, anon, authenticated;

-- ── amendment_unlock_outlives_booking  [low/lifecycle] ─────────────────────────────
create or replace function public.ctl_amendment_unlock_outlives_booking()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select b.id::text as entity_id,
       jsonb_build_object(
         'job_id', b.job_id::text,
         'job_title', j.title,
         'job_status', j.status,
         'poster_id', j.poster_id::text,
         'earner_id', b.earner_id::text,
         'booking_status', b.status,
         'amendment_status', b.amendment_status,
         'amendment_note', left(coalesce(b.amendment_note, ''), 200),
         'completed_at', b.completed_at,
         'days_since_completed', case when b.completed_at is null then null
                                      else floor(extract(epoch from now() - b.completed_at) / 86400) end,
         'live_booking_count', (
           select count(*) from public.bookings b2
            where b2.job_id = b.job_id
              and b2.status in ('confirmed', 'completed', 'verified')),
         'core_terms_unlocked', not exists (
           select 1 from public.bookings b3
            where b3.job_id = b.job_id
              and b3.status in ('confirmed', 'completed', 'verified')
              and coalesce(b3.amendment_status, 'none') <> 'accepted')
       ) as detail
  from public.bookings b
  join public.jobs j on j.id = b.job_id
 where b.status = 'verified'
   and b.amendment_status = 'accepted'$ctl$;
revoke execute on function public.ctl_amendment_unlock_outlives_booking() from public, anon, authenticated;

-- ── Registry ────────────────────────────────────────────────────────────────
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('earner_credit_missing', 'Money captured from a poster but never credited to the earner''s in-app ledger', 'critical', 'money', 'Both credit paths are non-transactional across two systems: stripe-capture-payment writes status=''captured'' at supabase/functions/stripe-capture-payment/index.ts:153-156 and only THEN calls credit_earnings (:166); stripe-tip charges the card, then calls claim_and_credit_tip (:136). If the function dies, the DB write fails, or credit_earnings returns false for any reason (it requires status=''captured'' AND earner_amount_cents > 0), the poster''s card is charged, the funds are on their way to the earner''s Connect balance, and profiles.earnings_* shows nothing. Nothing in the system reconciles this on its own — stripe-tip''s own comment at :145-147 says exactly that. Cost: the worker''s dashboard understates real pay, so they distrust the app and open support tickets; the tax-year CSV in ExpensesScreen is wrong; and a later refund is silently forgiven because debit_earnings refuses to debit a payment whose earnings_credited is false (20260804020000:45-47), so the platform eats it. Remedy is a one-line service_role call, but only if someone knows. 15-minute grace covers in-flight invocations. NOT YET VERIFIED AGAINST PRODUCTION — no psql and no service-role key on this machine; run', 'ctl_earner_credit_missing')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('payment_ledger_impossible', 'payments row is in an arithmetically impossible state', 'critical', 'money', 'There is NO trigger and NO constraint on public.payments beyond the status enum and refunded_cents <= amount_cents — every field-level invariant on the money table is enforced only by edge-function discipline. This asserts the four that must never break: (a) captured total (earner_amount_cents + fee_cents) exceeding the immutable authorization amount_cents — impossible in code, so a hit means someone captured from the Stripe Dashboard or the row was hand-edited; (b) refunded_cents exceeding the CAPTURED total — the CHECK constraint caps against amount_cents, the AUTHORIZATION (20260804010000:129-130), so a partially-captured row can be refunded past what was ever collected without violating it, and the platform pays the difference out of its own balance; (c) refunded_cents > 0 on a row that was never captured — refunding money nobody paid; (d) earnings_credited=true while status is not ''captured'' — credit_earnings can only set that flag under status=''captured'' (20260722010000:130-136) and every writer refuses to move a captured row (stripe-cancel-payment, admin-payment-action release_hold, the payment_failed/canceled webhook handlers are all status-guarded), so a hit means a gu', 'ctl_payment_ledger_impossible')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('escrow_hold_lapsed_uncancelled', 'Escrow authorization older than 8 days still reads ''authorized''', 'critical', 'money', 'Stripe auto-cancels an uncaptured manual-capture authorization ~7 days after it is placed. When that happens Stripe fires payment_intent.canceled, and stripe-webhook/index.ts:200-203 flips the row to ''cancelled''. So a row still sitting at ''authorized'' past day 8 means one of two things, both bad: the hold is dead at Stripe and our DB does not know (both UIs keep telling the poster and the earner ''funds are held'' when nothing is held, and a later capture throws), or — the reason this is the highest-leverage check in the set — payment_intent.canceled is NOT REGISTERED on the Stripe webhook destination at all, in which case EVERY expiring hold in the product is silently rotting. KNOWN_RISKS §8.1 names this the single highest-leverage live-verification item and it has never been proven in production. This control is the proof. Age is measured from greatest(created_at, cancelled_at) because a recovery re-hold upserts onto the same row without resetting created_at (stripe-create-payment-intent:261-268), so cancelled_at is the better lower bound on the current hold''s age. EXPECT ROWS ON FIRST RUN if any old test bookings were accepted and abandoned — triage them once, then it shoul', 'ctl_escrow_hold_lapsed_uncancelled')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('escrow_hold_expiring_work_done', 'Hold about to lapse on work the earner has already marked done', 'high', 'money', 'The exact shape of an unpaid worker, caught while there is still time to act. The earner did the job and set earner_done, the poster never verified, and the ~7-day Stripe authorization is between day 5 and day 8 of its life — so there is a 24-48 hour window in which stripe-capture-payment or earner-claim-payment can still capture real money, after which there is nothing left to capture and no code change can conjure it back (earner-claim-payment/index.ts:116-121 says so explicitly). The earner''s own self-settlement path may not even be open: it counts a 3-day grace from SLOT time while the hold ages from ACCEPT time, so for a gig booked 4+ days ahead the two windows historically never overlapped, and it hard-refuses with NO_SCHEDULE for any booking on a ''Flexible — Contact to Schedule'' slot, which is inserted with starts_at NULL (src/screens/PostJobScreen.js:201). RUNBOOK_MONEY §1 is the manual version of this check, which means today it only runs when a human remembers. Cost of a miss: a student worked for free, and the only recovery is an out-of-band apology payment. Age anchored on greatest(created_at, cancelled_at) so a recovery re-hold is not mis-aged; the upper bound hands', 'ctl_escrow_hold_expiring_work_done')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('money_exposed_on_dead_booking', 'Poster''s money still captured or still held on a declined/cancelled booking', 'critical', 'money', 'A booking that was declined or cancelled must leave no money in flight, and NOTHING in the database enforces that — the link between bookings.status and payments.status is pure edge-function convention. Two failures: (1) status=''captured'' on a dead booking means the poster was charged for a gig that never happened. forceCancel refuses to cancel around a captured payment (admin/app/(console)/bookings/actions.ts:186-190) and stripe-cancel-payment refuses too, so a hit means the capture landed AFTER the cancel (a racing payment_intent.succeeded webhook will happily stamp ''captured'' on any row, stripe-webhook:144-146) — the poster is out real money with no refund and will chargeback. (2) status=''authorized'' hours after the booking died means the hold release failed open: JobsContext cancelBooking sets ''cancelled'' first and then calls stripe-cancel-payment best-effort, and delete-account/deleteUser cancel the PI in a try/catch and never touch the payments row at all — so the poster''s available credit stays tied up for up to 7 days against a gig that no longer exists, and nothing else in the system will ever release it (KNOWN_RISKS §4.3). Residual to accept: there is no cancelle', 'ctl_money_exposed_on_dead_booking')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('settled_without_captured_payment', 'Booking claims settlement or confirmation with no captured payment behind it', 'critical', 'money', 'guard_bookings_write blocks completed->verified without a payments row at status=''captured'' (20260722000000:104-106), and pending->confirmed is absent from every client branch so accept-booking (which verifies pi.status===''requires_capture'' first) is the only confirm path. Both guards early-return for service_role. So this control is deliberately a canary on the guard being dropped, on a migration re-ordering it away, and on the three service-role paths that bypass it: earner-claim-payment writes status=''verified'' directly (index.ts:241-243), admin forceComplete/reopenBooking write lifecycle columns directly, and the assistant edge function creates bookings. A ''verified'' booking with no captured money is the worst outcome the product can produce — the earner has been told the job is settled and paid, the poster has been released, and no money moved; nobody discovers it until the worker checks their bank. A ''confirmed'' booking with no payments row at all is escrow bypass: the earner is shown a live accepted gig with nothing behind it and does the work for free. EXPECT ROWS ON FIRST RUN — this repo predates the Stripe integration, so any test bookings created before payment', 'ctl_settled_without_captured_payment')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('earnings_total_drift', 'profiles.earnings_total disagrees with the payment + tip + refund ledger', 'high', 'money', 'profiles.earnings_total has exactly three writers — credit_earnings (+earner_amount_cents on capture), claim_and_credit_tip (+amount_cents, tips carry no platform fee so 100% credits), and debit_earnings (-round(refunded_cents * earner_amount_cents / captured_total), called only from record_refund). guard_profiles_write pins the column to old.* for the owner and returns old for everyone else, so no client can touch it. That makes the balance an exact derived quantity, and NOTHING in the database enforces it. This is the one control that catches every credit/debit bug at once rather than one shape of it: a double-credit (capture path and webhook both crediting outside the atomic claim), a lost credit, a refund that moved money at Stripe but never debited, a tip credited twice, or a direct service-role write. It is also the number a worker reads as ''what I have earned'' and the basis of the Tax Center''s year figures, so drift is both a trust problem and a 1099 problem. Tolerance is 2c plus 2c per refunded payment, absorbing the one-rounding-vs-N-roundings difference between reconstructing from the final refunded_cents and the per-call rounding record_refund actually applied; expect', 'ctl_earnings_total_drift')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('external_reversal_not_ledgered', 'Stripe refund or chargeback seen by the webhook but never written to the payments ledger', 'high', 'money', 'stripe-webhook''s charge.refunded and charge.dispute.created handlers (index.ts:281-332) do exactly two things: insert a disputes row and email the admin. They never touch payments.refunded_cents, so for any reversal issued outside the admin console — a refund clicked in the Stripe Dashboard, or a lost chargeback, which Stripe will not even let refunds.create touch — the ledger keeps claiming the platform collected money it no longer has. GMV and admin_dashboard_metrics overstate revenue permanently, and because record_refund is the only caller of debit_earnings, the earner''s earnings_total is never reduced either: the money left the connected account via reverse_transfer but the worker''s dashboard still shows it. ADMIN_AUDIT M3 is only half-fixed — the console gained a ''Record chargeback'' button (admin-payment-action op record_reversal) but RUNBOOK_MONEY §2 relies on a human remembering to press it, and nothing detects when they did not. This control is the detector. No false positives from console refunds: admin-payment-action stamps refund_source=''admin'' before calling Stripe, and recordReversal early-returns for that source (webhook :68-71), so no disputes row is filed. 2', 'ctl_external_reversal_not_ledgered')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('booking_status_contradicts_done_flags', 'Booking status and the two done-flags disagree', 'medium', 'lifecycle', 'Mutual completion is the core consent rule of the whole product: neither party alone may advance a booking to ''completed''. It is enforced in two places, both bypassable by service_role — guard_bookings_write (20260722000000) pins the other party''s flag and permits confirmed->completed only when both are true, and trg_advance_mutual_completion (20260624210000) is the arbiter that flips the status. This control is deliberately a canary on those two, not a re-assertion: it fires only if a guard is dropped, an edge function writes status directly, or an admin path sets one without the other. Both directions are checked. Shape (a) status completed/verified without both flags means someone was marked as having finished work they never agreed was finished — that is the state that captures the poster''s escrow and produces a review against the earner. Shape (b) status still ''confirmed'' with both flags true means the arbiter did not run (it is BEFORE UPDATE only, so a service-role INSERT slips it), leaving a booking that both sides consider done, that no client screen offers a next action on, and whose authorization silently ages out to a ~7-day lapse. Should be zero today: verifyAndRa', 'ctl_booking_status_contradicts_done_flags')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('live_booking_on_dead_job', 'Confirmed or completed booking sitting on a cancelled or completed job', 'high', 'lifecycle', 'jobs.status has NO transition guard anywhere in the database. guard_jobs_write (20260726110000) pins pay, terms and location while a booking is live but never references new.status, and jobs_update_own lets any poster PATCH it. The client exploits this: deleteJob (src/context/JobsContext.js:1030) issues a bare `update({status:''cancelled''})` with zero check for live bookings — a poster who taps ''delete gig'' after accepting someone silently kills the listing out from under a confirmed earner. The booking survives with its escrow hold intact, the earner still shows it under My Jobs, and the poster believes the gig is gone. The converse (job marked ''completed'' while another booking on it is still confirmed/completed) is the failure mode verifyAndRate''s fail-safe multi-slot check at JobsContext.js:896-908 exists to prevent, so a hit there means that check was bypassed or lost its race. Scoped to confirmed/completed deliberately: a poster withdrawing a listing that only has pending applications is legitimate withdrawal, and is covered by stranded_pending_booking instead. MAY RETURN ROWS TODAY — if any poster has ever deleted a gig with a confirmed booking on it, that row is sittin', 'ctl_live_booking_on_dead_job')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('live_booking_without_schedule_anchor', 'Live booking whose scheduled time cannot be resolved from its slot', 'high', 'lifecycle', 'earner-claim-payment is the earner''s only self-service payout path when a poster ghosts. It refuses to derive the schedule from bookings.starts_at (the earner can PATCH that on their own row) and instead reads job_slots.starts_at via booking.slot_id, returning NO_SCHEDULE permanently if slot_id is null or the slot has no starts_at (index.ts:82-89). Four distinct failures land in that same dead end and this control catches all of them as one question — ''can this booking ever be settled without a human?'': no slot_id at all; slot_id pointing at a row that no longer exists (bookings.slot_id has NO foreign key — schema.sql:66 declares it as a bare uuid — so updateJob''s ''don''t delete booked slots'' filter at JobsContext.js:1010-1013 is the only thing preventing a dangling pointer, and a dangling pointer also silently breaks trg_sync_slot_taken and trg_guard_job_slot_settlement_anchor, which both key off slot_id); a slot belonging to a different job (guard_bookings_write validates job ownership on INSERT only); and a slot with a null starts_at. WILL RETURN ROWS TODAY, and that is the point. The ''Flexible — Contact to Schedule'' fallback slot is inserted with starts_at null (PostJob', 'ctl_live_booking_without_schedule_anchor')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('stranded_pending_booking', 'Pending application left unanswered past any window in which it could matter', 'medium', 'lifecycle', 'A pending booking is an application the poster has never accepted or declined, and nothing in the system ever expires one. It is not merely untidy: bookings_one_active_per_slot (20260624220000:95-98) counts ''pending'' as live, and trg_sync_slot_taken therefore flips job_slots.taken to true the instant an application arrives. So one ignored application removes that slot from the market permanently — no other earner can book it, and the poster gets no signal that their own gig has quietly become unbookable. The earner meanwhile sees the gig sitting under Awaiting forever with no way to withdraw it from limbo. Two branches, one question (''is this application past the point of being actionable?''): a scheduled booking whose slot time is more than a day gone, and an unscheduled one (the Flexible-slot case, which has starts_at null by construction and would otherwise be invisible to this check — exactly the gigs most likely to be ghosted) that has been open a fortnight. Anything this control finds is a slot to free and two users to close the loop with. MAY RETURN ROWS TODAY in proportion to how often posters ignore applications; a large initial count is a real product finding (applicat', 'ctl_stranded_pending_booking')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('slot_taken_flag_drift', 'job_slots.taken disagrees with the live bookings on that slot', 'low', 'integrity', 'job_slots.taken is a denormalised cache of ''does a live booking exist for this slot'', maintained by trg_sync_slot_taken (20260624220000:100-122). That trigger fires ONLY on writes to bookings, so nothing recomputes it when job_slots itself is written — and slots_insert_poster / slots_update_poster let any poster set taken directly from a PostgREST call. This control asserts the cache against its own definition, using exactly the status set the trigger uses, so healthy is zero by construction. Both directions cost something real. taken=true with no live booking hides a genuinely bookable slot from every earner — invisible lost inventory, and the poster has no way to tell why their gig gets no applications. taken=false with a live booking is worse in the moment: the slot renders as available in SlotPicker, a second earner taps book, and bookings_one_active_per_slot rejects the INSERT with a raw unique-violation that surfaces as an unexplained failure rather than ''already taken''. Also the cheapest available detector for a dangling booking.slot_id (there is no FK on that column), since the orphaned slot''s flag can never be recomputed again.', 'ctl_slot_taken_flag_drift')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('dispute_resolution_desync', 'Dispute status and resolved_at contradict each other', 'high', 'integrity', 'The disputes table carries its lifecycle in two columns that must move together, and nothing enforces that — 20260804010000 added status with a CHECK on its values and resolved_at as a plain nullable timestamptz, with no constraint tying them. The console keeps them in step (disputes/actions.ts:53-56) but it is not the only writer, and neither is it the reader that matters. The two columns are consumed by DIFFERENT consumers, which is what makes the desync silent and expensive. earner-claim-payment gates settlement on `resolved_at is null` (index.ts:149-154, fail-closed) — so a dispute an operator has closed in the UI (status=''resolved'') whose resolved_at never got written continues to block that earner''s payout forever, which is the exact permanent-payout-block failure 20260804010000 was written to eliminate, reintroduced by a half-written row. The queue index and admin_dashboard_metrics'' disputes_open both filter on `resolved_at is null` — so the opposite shape (resolved_at set, status still open/investigating) makes a live dispute vanish from the operator queue while every UI that reads status still shows it unresolved. Zero on a healthy system: both live writers set the pai', 'ctl_dispute_resolution_desync')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('dispute_open_beyond_sla', 'Dispute unresolved for more than 14 days', 'high', 'lifecycle', 'An open dispute is not a ticket, it is an active hold on someone''s wages. earner-claim-payment blocks self-settlement on any dispute row with resolved_at null (index.ts:149-154), and it fails CLOSED — so for as long as nobody resolves it, the earner has no route to their money except a human. Nothing in the schema ages a dispute, nothing escalates one, and disputes_open on the admin dashboard is a count with no oldest-first pressure: a dispute that no operator happens to click can sit open indefinitely and the only person who feels it is the unpaid worker, who has no visibility into why. Fourteen days is an explicit SLA, chosen to be well clear of the ~7-day authorization lifetime — by the time this fires the escrow behind the booking is long dead, so every finding is also a manual-settlement job, not just a triage job. This is the control that turns ''the queue has no expiry'' from an operator''s good intentions into an enforced commitment. MAY RETURN ROWS TODAY if any dispute predates the resolution lifecycle that 20260804010000 added — before that migration a dispute row was terminal by construction, so historical rows have no resolved_at and never can have had one. Sweep those', 'ctl_dispute_open_beyond_sla')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('amendment_unlock_outlives_booking', 'Accepted amendment left standing on a settled booking, keeping the job''s terms unlocked', 'low', 'lifecycle', 'amendment_status=''accepted'' is not a historical note, it is a live permission. guard_jobs_write computes has_amend as `not exists (a booking in confirmed/completed/verified without an accepted amendment)` (20260726110000:75-80) and, when true, stops pinning title, category, location, lat, lng, description and hazards. Note that ''verified'' is inside that live set — so a settled, paid, rated booking whose amendment was never cleared keeps the unlock open on its job forever. Clearing it is entirely client-driven and best-effort: clearAmendment (JobsContext.js:1277-1280) is called from the poster''s edit flow and its result is never checked, so a poster who proposes a change, gets consent, then simply never edits leaves the permission standing permanently. The exposure is that the poster can silently rewrite the agreed location and description of a completed gig after the fact — the record of what was actually agreed becomes editable by one party, which matters precisely when a dispute or a safety report is filed about that job later. Scoped to status=''verified'' deliberately: an accepted amendment on a confirmed or completed booking is the flow working normally and mid-window. Th', 'ctl_amendment_unlock_outlives_booking')
on conflict (key) do update set title=excluded.title, severity=excluded.severity,
  domain=excluded.domain, why=excluded.why, fn_name=excluded.fn_name;
