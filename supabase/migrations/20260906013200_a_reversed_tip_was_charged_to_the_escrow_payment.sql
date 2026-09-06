-- ─────────────────────────────────────────────────────────────────────────────
-- A refunded TIP opened a HIGH money finding against the ESCROW charge, and the
-- remedy the finding printed would have corrupted the ledger.
--
-- recordReversal (stripe-webhook) finds no payments row for a tip's PaymentIntent, falls
-- back to tip_ledger, reverses the tip correctly via record_tip_reversal — and then set
-- `bookingId = tip.booking_id` and FELL THROUGH into the generic path, which files a
-- disputes row against the BOOKING with the standard template:
--
--   'Stripe refund on charge ch_… (usd 20.00 refunded)'
--
-- That is precisely the anchored template ctl_external_reversal_not_ledgered selects on.
-- The control then joins the row to the booking's CAPTURED escrow payment — a $100 gig
-- that Stripe never reversed — and 24 hours later reports 'reversal 2000, refunded 0,
-- unledgered 2000'. Its remedy says "Use admin console -> booking -> Record chargeback,
-- which writes refunded_cents". Following it writes a reversal onto a charge Stripe never
-- touched: GMV and platform fees permanently misstated, refund_ledger carrying a
-- 'chargeback' that never happened, and reconcile-stripe left in a refund_mismatch it
-- can never clear. The finding could not auto-resolve either — the only thing that would
-- close it was that wrong write.
--
-- The same row also freezes a THIRD PARTY's money (vest_bonuses holds a referral bonus
-- while any open dispute exists on the source booking) and trips
-- ctl_dispute_open_beyond_sla at 14 days.
--
-- Neither exemption in recordReversal could catch it: for a refund, `row` is the null
-- payments lookup so `(row?.refunded_cents ?? 0) >= stripeRefundedCents` is false for any
-- positive refund, and the chargeback arm skips that block entirely.
--
-- ── THE EDGE FIX, in the same commit ─────────────────────────────────────────
-- recordReversal now RETURNS tip.booking_id immediately after record_tip_reversal.
-- tip_ledger.reversed_cents / reversed_at / reversal_reason IS the record, and
-- ctl_earnings_total_drift already subtracts it. The admin email still goes out, because
-- the caller only wants the booking id for that.
--
-- ── WHY THE CONTROL CHANGES TOO ──────────────────────────────────────────────
-- The edge fix stops NEW rows. It does nothing about rows already filed, and those are
-- the dangerous half: each one is an open HIGH finding printing a remedy that corrupts
-- the ledger, on a queue an operator is meant to trust. So the control now asks the
-- question it always meant to ask — "did OUR ledger account for this reversal?" — of the
-- right ledger. A reversal whose stated amount exactly matches a reversed tip on the same
-- booking IS accounted for, in tip_ledger.
--
-- Deliberately an EXACT amount match, and deliberately not a blanket "this booking has a
-- reversed tip" skip: masking a genuine unledgered escrow reversal is the one thing this
-- control exists to prevent. The control already reduces to one dispute row per booking
-- (distinct on, newest first), so the coincidence needed to hide a real finding is an
-- escrow reversal for exactly the same cents as a reversed tip on the same booking, whose
-- dispute row is also the newest. Everything else still fires.
--
-- The chargeback arm needed its own amount: reversal_cents is null there by design (a
-- chargeback moves no refund figure, and the control's null branch depends on that), so
-- `stated_cents` is parsed separately from both templates purely for this comparison and
-- changes nothing else.
--
-- Found by the money-edge-webhook audit pass, 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

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
           as reversal_cents,
         -- The amount the row STATES, from either template. reversal_cents stays null
         -- for a chargeback because the control's null branch depends on that; this is
         -- only ever used to ask whether tip_ledger already accounts for the money.
         coalesce(
           round(substring(dd.reason from '([0-9]+\.[0-9]{2}) refunded\)')::numeric * 100)::bigint,
           round(substring(dd.reason from ', [a-z]{3} ([0-9]+\.[0-9]{2})\)$')::numeric * 100)::bigint
         ) as stated_cents
    from public.disputes dd
   -- Two writers reach this column. The prefix is the cheap scan filter; the anchored
   -- pattern is what separates stripe-webhook's template from a poster's typed note,
   -- which lands here verbatim from the "report a problem" flow. A Stripe object id and
   -- a fixed shape end to end is not something free text produces by accident.
   where (
           dd.reason ilike 'Stripe refund on charge%'
       and dd.reason ~ '^Stripe refund on charge (ch|py)_[A-Za-z0-9]{8,} \([a-z]{3} [0-9]+\.[0-9]{2} refunded\)$'
         )
      or (
           dd.reason ilike 'Stripe chargeback%'
       and dd.reason ~ '^Stripe chargeback (dp|du)_[A-Za-z0-9]{8,} \([^()]*, [a-z]{3} [0-9]+\.[0-9]{2}\)$'
         )
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
              'genuinely recovered from them. FIRST check the charge id in the reason is this '
              'booking''s ESCROW charge and not a tip: a tip reversal is recorded in '
              'tip_ledger and must never move refunded_cents on the escrow payment.'
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
  -- ── A reversed TIP is already ledgered, just not in `payments` ─────────────
  -- Tips carry their own PaymentIntent and their own ledger. recordReversal used to
  -- file the booking-level dispute row anyway, so the control attributed a tip's
  -- refund to the escrow charge and told an operator to write refunded_cents onto a
  -- charge Stripe never reversed. Exact-amount match only: see the header.
  and not exists (
    select 1
      from public.tip_ledger t
     where t.booking_id = p.booking_id
       and d.stated_cents is not null
       and coalesce(t.reversed_cents, 0) = d.stated_cents
  )
$function$;

revoke execute on function public.ctl_external_reversal_not_ledgered() from public, anon, authenticated;


-- ── Prove the misattribution is gone and the real finding still fires ───────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'tip reversal probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;

  -- A fully captured $100 escrow charge that Stripe has NEVER reversed.
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     status, captured_at, refunded_cents)
  values (bid, 'pi_probe_tiprev_' || replace(bid::text, '-', ''), 10000, 700, 9300,
          'captured', now() - interval '3 days', 0)
  returning id into pid;

  -- The $20 tip, refunded and correctly recorded in tip_ledger by record_tip_reversal.
  insert into public.tip_ledger
    (booking_id, earner_id, amount_cents, payment_intent_id, reversed_cents, reversed_at)
  values (bid, uid, 2000, 'pi_probe_tip_' || replace(bid::text, '-', ''),
          2000, now() - interval '2 days');

  -- THE BROKEN ROW: the booking-level dispute the old fall-through filed, naming the
  -- TIP's charge with the ESCROW charge's template.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, 'Stripe refund on charge ch_probeTIP12345678 (usd 20.00 refunded)',
          now() - interval '2 days');

  select count(*) into n
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n <> 0 then
    raise exception 'FIX FAILED: a reversed TIP still opens a HIGH finding against the escrow payment (% rows) — and its remedy would write refunded_cents onto a charge Stripe never touched', n;
  end if;
  raise notice 'FIXED: a tip reversal that tip_ledger already accounts for no longer reaches the escrow payment';

  -- ── AND THE CONTROL STILL DOES ITS JOB ────────────────────────────────────
  -- A genuine unledgered escrow refund, for a DIFFERENT amount, must still fire. If
  -- the exclusion were a blanket "this booking has a reversed tip" it would not.
  update public.disputes
     set reason = 'Stripe refund on charge ch_probeESCROW1234 (usd 45.00 refunded)'
   where booking_id = bid;
  select count(*) into n
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n <> 1 then
    raise exception 'a real unledgered escrow refund on a booking that also had a reversed tip is no longer reported (% rows)', n;
  end if;
  raise notice 'discriminates: a $45 escrow refund on the SAME booking still fires (% row)', n;

  -- ...and once our ledger records it, the finding resolves. Unchanged behaviour.
  update public.payments set refunded_cents = 4500, refunded_at = now() where id = pid;
  select count(*) into n
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n <> 0 then
    raise exception 'the finding no longer auto-resolves once refunded_cents is written';
  end if;
  raise notice 'ledgering the real reversal closes the finding, so it still auto-resolves';

  -- A chargeback-shaped tip row is excluded too — that arm carries no reversal_cents,
  -- so it needed the separately-parsed amount to be reachable at all.
  update public.payments set refunded_cents = 0, refunded_at = null where id = pid;
  update public.disputes
     set reason = 'Stripe chargeback dp_probeTIP12345678 (fraudulent, usd 20.00)'
   where booking_id = bid;
  select count(*) into n
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n <> 0 then
    raise exception 'a tip CHARGEBACK still opens a finding against the escrow payment (% rows)', n;
  end if;
  raise notice 'the chargeback template is excluded too, via the separately-parsed amount';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'tip-reversal-attribution probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
