-- ─────────────────────────────────────────────────────────────────────────────
-- Stop RECOMPUTING what the earner lost. Record it.
--
-- An adversarial review of yesterday's refund work found one HIGH and three MEDIUMs
-- that are all the same mistake wearing different clothes: three separate places
-- re-derive the earner's share of a refund with the formula
--
--     round(refunded_cents * earner_amount_cents / (earner_amount_cents + fee_cents))
--
-- and since 20260813160000 that formula is WRONG on the chargeback path, because
-- record_refund is called with p_debit_earner => false there and debits nothing.
--
--  1. src/lib/payments.js:152 (HIGH) subtracts the share on EVERY row with
--     refunded_cents > 0. On a $60 lost chargeback the earner's Transactions row reads
--     "+$0.00" and the receipt reads "Your share of the refund − $55.80" — while their
--     earnings dashboard still says $55.80, the money is genuinely in their Connect
--     account, and Bank deposits still lists the payout that carried it. Commit 288135c
--     set out to remove exactly this "two surfaces, one event, two numbers"
--     disagreement and re-created it $55.80 wide, pointing the other way.
--  2. ctl_earnings_total_drift's `clawed` CTE does the same, so the FIRST recorded
--     chargeback raises a HIGH finding that can never auto-resolve — the control and
--     the code now disagree by design. ATTACK_FINDINGS.md:262 said explicitly that any
--     fix "has to change both the reversal path and that control". Two migrations
--     changed the path and left the control alone. This is the third.
--  3. The JS applies ONE rounding to the cumulative total while record_refund applied
--     one per call, so N partial refunds drift by up to N/2 cents even when the branch
--     is right.
--
-- The formula is not the problem — keeping three copies of it in sync with a
-- conditional branch is. `payments.earner_refunded_cents` now records what
-- debit_earnings ACTUALLY took: the exact integer, summed per call, and 0 on a
-- chargeback because 0 is what was taken. Every reader reads it instead of guessing.
-- The client comment promising to stay "byte-for-byte equivalent to record_refund's
-- own debit" describes a hazard, not a safeguard; there is now nothing to be
-- equivalent to.
--
-- ── The in-flight marker could stick forever ────────────────────────────────
--
-- refund_source is stamped 'admin' BEFORE the Stripe call and cleared by record_refund.
-- But two `return`s sit above that clear (the over-refund cap, and the ON CONFLICT
-- replay), and admin-payment-action's outer catch returns 500 without clearing. Any of
-- those leaves the marker set permanently, and stripe-webhook skips on
-- `inFlight || alreadyLedgered` — an OR, so a wrongly-true inFlight wins outright and
-- the correct alreadyLedgered value is discarded. My own commit message claimed the two
-- tests "each cover the other's race"; that is false for an OR. Every later external
-- reversal on that payment then goes unrecorded, which is the exact bug the chargeback
-- scoping was meant to end.
--
-- Fixed twice over: record_refund now clears the marker on EVERY exit path, and the
-- marker is time-bounded by `refund_source_at` so no future path can re-create a
-- permanent skip. A stuck flag now expires in minutes instead of lasting forever.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.payments
  add column if not exists earner_refunded_cents integer not null default 0,
  add column if not exists refund_source_at timestamptz;

comment on column public.payments.earner_refunded_cents is
  'Cents actually taken off the earner via debit_earnings, summed across refunds. 0 on a '
  'lost chargeback (the platform absorbs it). Recorded, never recomputed — the '
  'proportional formula is wrong on the chargeback path and drifts under partial refunds.';

-- Backfill: every pre-existing refund predates the chargeback split, so all of them went
-- down the debiting path and the old formula is correct FOR THEM. Production has zero
-- rows with refunded_cents > 0, so this is a no-op today and correct if that changes.
update public.payments
   set earner_refunded_cents =
         round(coalesce(refunded_cents, 0)::numeric
               * coalesce(earner_amount_cents, 0)
               / nullif(coalesce(earner_amount_cents, 0) + coalesce(fee_cents, 0), 0))::integer
 where coalesce(refunded_cents, 0) > 0
   and coalesce(earner_refunded_cents, 0) = 0;

create or replace function public.record_refund(
  p_payment_id   uuid,
  p_cents        integer,
  p_reason       text,
  p_admin        uuid,
  p_debit_earner boolean default true,
  p_external_id  text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_captured integer;
  v_already  integer;
  v_earner_share integer;
  v_new      integer;
begin
  select coalesce(earner_amount_cents, 0) + coalesce(fee_cents, 0), coalesce(refunded_cents, 0)
    into v_captured, v_already
    from public.payments
   where id = p_payment_id
   for update;

  if v_captured is null then
    return null;
  end if;

  if v_already + p_cents > v_captured then
    -- REFUSED — but the in-flight marker must still go. Returning with it set is one of
    -- the three paths that left it stuck forever, silencing every later external
    -- reversal on this payment.
    update public.payments
       set refund_source = null, refund_source_at = null
     where id = p_payment_id;
    return null;
  end if;

  if p_external_id is not null then
    insert into public.refund_ledger (payment_id, external_id, kind, cents, recorded_by)
    values (
      p_payment_id,
      p_external_id,
      case when p_debit_earner then 'refund' else 'chargeback' end,
      p_cents,
      p_admin
    )
    on conflict (external_id) do nothing;

    if not found then
      -- Already recorded. Clear the marker here too — this is the second path that used
      -- to return above the clear.
      update public.payments
         set refund_source = null, refund_source_at = null
       where id = p_payment_id;
      return v_already;
    end if;
  end if;

  -- The exact figure debit_earnings will take, computed ONCE and then recorded, so no
  -- reader ever has to reproduce it. 0 on a chargeback, because 0 is what is taken.
  if p_debit_earner then
    select round(p_cents::numeric * coalesce(earner_amount_cents, 0) / nullif(v_captured, 0))::integer
      into v_earner_share
      from public.payments where id = p_payment_id;
  else
    v_earner_share := 0;
  end if;

  v_new := v_already + p_cents;
  update public.payments
     set refunded_cents = v_new,
         -- Accumulated per call, matching how debit_earnings is applied per call. A
         -- single rounding of the cumulative total disagrees with N roundings of the
         -- parts, which is where the old tolerance-fudging in the control came from.
         earner_refunded_cents = coalesce(earner_refunded_cents, 0) + v_earner_share,
         refunded_at    = now(),
         refund_reason  = p_reason,
         refunded_by    = p_admin,
         refund_source  = null,
         refund_source_at = null
   where id = p_payment_id;

  if p_debit_earner and v_earner_share > 0 then
    perform public.debit_earnings(p_payment_id, v_earner_share);
  end if;

  return v_new;
end;
$function$;

revoke execute on function public.record_refund(uuid, integer, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, integer, text, uuid, boolean, text) to service_role;

-- ── The control must measure what happened, not what it assumes ─────────────
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
  -- Reads what was RECORDED as taken. The old body rebuilt this proportionally from
  -- refunded_cents, which since 20260813160000 is wrong on every lost chargeback: that
  -- path raises refunded_cents and debits nothing, so the control expected a clawback
  -- that never happened and would have opened a permanent, unresolvable HIGH finding
  -- against a real earner on the first one.
  select b.earner_id as uid,
         sum(coalesce(p.earner_refunded_cents, 0))::bigint as cents,
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
    -- Was 0.02 + 0.02*n, absorbing the one-rounding-vs-N-roundings gap this CTE used to
    -- create for itself. The figure is now exact, so the slack per refunded payment is
    -- gone; 2c stays for the dollars/cents conversion.
    0.02::numeric as tol
) e
where abs(coalesce(pr.earnings_total, 0) - e.expected) > e.tol$ctl$;
revoke execute on function public.ctl_earnings_total_drift() from public, anon, authenticated;

update public.controls
   set why = 'profiles.earnings_total has three writers — credit_earnings (+earner_amount_cents on '
             'capture), claim_and_credit_tip (+amount_cents, tips carry no platform fee) and '
             'debit_earnings (called only from record_refund). The clawback is read from '
             'payments.earner_refunded_cents, which records what debit_earnings ACTUALLY took, '
             'rather than rebuilt proportionally from refunded_cents: a LOST CHARGEBACK raises '
             'refunded_cents and deliberately debits nothing (20260813160000 — the platform '
             'absorbs it on a destination charge), so the proportional form expected a clawback '
             'that never happened and opened a permanent unresolvable finding on the first one. '
             'Recording the figure also removes the per-call rounding slack the old tolerance '
             'existed to absorb. guard_profiles_write pins the column for the owner, so no client '
             'can touch it: the balance is an exact derived quantity that nothing in the database '
             'enforces, which is why this control catches every credit/debit bug at once.'
 where key = 'earnings_total_drift';

-- ── The remedy told the operator to move money a second time ────────────────
-- 'admin console -> booking -> Record chargeback (or Refund), so record_refund writes
-- refunded_cents and debits the earner' was carried forward verbatim into this control
-- and is wrong on both halves. "Refund" calls stripe.refunds.create with
-- reverse_transfer:true — it MOVES MONEY, and this control fires precisely when our
-- refunded_cents is 0, so its cap and its idempotency key are both computed from a
-- ledger that does not know a refund already happened at Stripe. An operator following
-- it refunds the poster twice and claws the second one out of the earner's account. And
-- "debits the earner" has been false for the chargeback op since 20260813160000.
create or replace function public.ctl_external_reversal_not_ledgered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $function$
with reversal as (
  select distinct on (dd.booking_id)
         dd.booking_id,
         dd.id,
         dd.reason,
         dd.created_at,
         dd.resolved_at,
         round(substring(dd.reason from '([0-9]+\.[0-9]{2}) refunded\)')::numeric * 100)::bigint
           as reversal_cents
    from public.disputes dd
   where dd.reason ilike 'Stripe refund on charge%'
      or dd.reason ilike 'Stripe chargeback%'
   order by dd.booking_id, dd.created_at desc
)
select p.id::text,
  jsonb_build_object(
    'booking_id', p.booking_id,
    'payment_status', p.status,
    'payment_intent_id', p.payment_intent_id,
    'authorized_cents', p.amount_cents,
    'captured_total_cents', coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0),
    'reversal_cents', d.reversal_cents,
    'refunded_cents', coalesce(p.refunded_cents, 0),
    'unledgered_cents',
      case when d.reversal_cents is null then null
           else d.reversal_cents - coalesce(p.refunded_cents, 0) end,
    'refund_source', p.refund_source,
    'earnings_credited', coalesce(p.earnings_credited, false),
    'earner_id', b.earner_id,
    'dispute_id', d.id,
    'dispute_reason', d.reason,
    'dispute_created_at', d.created_at,
    'dispute_resolved_at', d.resolved_at,
    'basil_note', 'partial-capture releases no longer appear in amount_refunded '
                  '(Stripe 2025-03-31.basil), so this figure is compared raw. Correct '
                  'only while the API version pin is 2026-07-29.dahlia.',
    'remedy', 'The money ALREADY moved at Stripe — this is a bookkeeping gap, not a refund '
              'to issue. Use admin console -> booking -> Record chargeback, which writes '
              'refunded_cents WITHOUT calling Stripe. Do NOT press Refund: that creates a '
              'SECOND real refund (reverse_transfer:true), and because our refunded_cents is '
              '0 here both its cap and its idempotency key are computed from a ledger that '
              'does not know about the Stripe-side refund, so nothing stops it. Note Record '
              'chargeback does not debit the earner (20260813160000 — the platform absorbs a '
              'destination-charge reversal); reconcile the earner separately if the money was '
              'genuinely recovered from them.'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join reversal d on d.booking_id = p.booking_id
where p.status = 'captured'
  and d.created_at < now() - interval '24 hours'
  and (
        (d.reversal_cents is null and coalesce(p.refunded_cents, 0) = 0)
        or
        (d.reversal_cents is not null
         and d.reversal_cents > coalesce(p.refunded_cents, 0))
      )
$function$;

revoke execute on function public.ctl_external_reversal_not_ledgered() from public, anon, authenticated;

-- ── Prove the chargeback path no longer fabricates an earner loss ───────────
do $$
declare
  bid uuid; pid uuid; jid uuid; uid uuid;
  e0 numeric; e1 numeric;
  v_earner_refunded integer; v_refunded integer; v_src text;
  drift_rows int; old_expected_claw numeric;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'chargeback display probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status)
  values (jid, uid, 'verified') returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, refund_source, earnings_credited)
  values (bid, 'pi_chargeback_display_probe', 6000, 420, 5580, 0, 'captured', now(), 'chargeback', true)
  returning id into pid;

  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  update public.profiles set earnings_total = e0 + 500 where id = uid;
  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  if e0 < 500 then raise exception 'could not seed a balance — probe cannot discriminate'; end if;

  -- A LOST CHARGEBACK for the full captured amount: p_debit_earner => false.
  perform public.record_refund(pid, 6000, 'probe chargeback', uid, false, 'chargeback_probe_AAA');

  select coalesce(earnings_total, 0) into e1 from public.profiles where id = uid;
  select coalesce(earner_refunded_cents, 0), coalesce(refunded_cents, 0), refund_source
    into v_earner_refunded, v_refunded, v_src
    from public.payments where id = pid;

  if v_refunded <> 6000 then
    raise exception 'staging wrong: refunded_cents is %', v_refunded;
  end if;
  if e1 <> e0 then
    raise exception 'a chargeback DEBITED the earner: % -> %', e0, e1;
  end if;

  -- THE FIX: the recorded figure is 0, so no reader can render a loss that never happened.
  if v_earner_refunded <> 0 then
    raise exception 'FIX FAILED: earner_refunded_cents is % on a chargeback, expected 0', v_earner_refunded;
  end if;

  -- What the OLD recompute would have produced on this same row — the number the app
  -- and the control were both about to show.
  if round(6000::numeric * 5580 / 6000) <> 5580 then
    raise exception 'probe is not discriminating: the old formula also produced 0';
  end if;
  raise notice 'discriminates: old formula claimed a 5580c earner loss, recorded figure is %',
    v_earner_refunded;

  -- And the CONTROL must attribute no clawback to this earner.
  --
  -- Asserting "the control returns no row" would be wrong here: the probe deliberately
  -- seeds +$5.00 onto a REAL profile that already has real payments, so this earner is
  -- genuinely in drift for reasons that have nothing to do with the chargeback. The
  -- property under test is the `clawed` CTE — it must value this reversal at 0 rather
  -- than the 5580c the old proportional form produced.
  select (detail->>'refund_clawback_cents')::numeric into old_expected_claw
    from public.ctl_earnings_total_drift() where entity_id = uid::text;

  if old_expected_claw is null then
    raise exception 'probe could not read the control detail for this earner';
  end if;
  if old_expected_claw <> 0 then
    raise exception
      'CONTROL STILL EXPECTS A CLAWBACK: %c attributed to an absorbed chargeback', old_expected_claw;
  end if;
  raise notice 'ctl_earnings_total_drift attributes 0c of clawback to an absorbed chargeback';
  drift_rows := 0;

  if v_src is not null then
    raise exception 'refund_source still % after ledgering', v_src;
  end if;

  -- A REFUSED refund must also clear the marker (one of the stuck-forever paths).
  update public.payments set refund_source = 'admin', refund_source_at = now() where id = pid;
  perform public.record_refund(pid, 999999, 'over cap', uid, true, 're_probe_over');
  select refund_source into v_src from public.payments where id = pid;
  if v_src is not null then
    raise exception 'FIX FAILED: a refused refund left refund_source stuck at %', v_src;
  end if;
  raise notice 'a refused refund clears the in-flight marker';

  -- As must a REPLAY.
  update public.payments set refund_source = 'admin', refund_source_at = now() where id = pid;
  perform public.record_refund(pid, 6000, 'probe chargeback', uid, false, 'chargeback_probe_AAA');
  select refund_source into v_src from public.payments where id = pid;
  if v_src is not null then
    raise exception 'FIX FAILED: a replayed refund left refund_source stuck at %', v_src;
  end if;
  raise notice 'a replayed refund clears the in-flight marker';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'chargeback-display probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
