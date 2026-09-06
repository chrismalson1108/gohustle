-- ─────────────────────────────────────────────────────────────────────────────
-- A reversed TIP was reported as an unledgered reversal of the GIG payment, with a
-- printed remedy that corrupts the gig ledger and voids the referral bonus.
--
-- f9b2550 taught stripe-webhook's recordReversal to fall back to tip_ledger, so a
-- refunded or charged-back tip finally reached record_tip_reversal. Correct as far as it
-- went — but the branch set `bookingId` and FELL THROUGH. The skip logic underneath reads
-- the `payments` row, which does not exist for a tip (stripe-tip charges its own
-- PaymentIntent and records it only in tip_ledger), so `inFlight` was false and
-- `alreadyLedgered` was false for any positive figure. Nothing stopped the insert, and the
-- disputes row it wrote carried the TIP's charge or dispute id in the machine template —
--
--     Stripe refund on charge ch_… (usd 20.00 refunded)
--
-- — on the GIG's booking. That is the exact string ctl_external_reversal_not_ledgered
-- anchors on, and the control joins disputes to payments on booking_id, so 24 hours later
-- the gig's captured, never-refunded payment was reported at HIGH severity as carrying an
-- unledgered $20 reversal.
--
-- The remedy it printed then made it worse: "Use admin console -> booking -> Record
-- chargeback, which writes refunded_cents WITHOUT calling Stripe." Following it writes
-- refunded_cents onto a charge nobody refunded. The poster's Transactions receipt then
-- reads "Refunded to you $20.00" on the gig; and vest_bonuses (20260814150000:49-54,
-- :80-85) voids any bonus_ledger row whose source booking has refunded_cents > 0, handing
-- the campaign budget back and taking a referral credit off an earner who did nothing.
-- Independently, the open disputes row blocks earner-claim-payment (DISPUTE_OPEN) and
-- holds bonus vesting from the moment the webhook fires. And because the control has no
-- `resolved_at is null` filter, resolving the spurious row by hand does NOT clear the
-- finding — only the corrupting write does, so the pressure is entirely one way.
--
-- Since 20260814090000 there is no console path to refund a tip at all, so the Stripe
-- Dashboard is the ONLY way one gets reversed. This fired on every tip reversal.
--
-- ── TWO HALVES, and this file is the second ─────────────────────────────────
-- The WRITER is fixed in the same change: recordReversal now returns the tip's booking id
-- immediately after record_tip_reversal, so no such row is written again. A disputes row
-- is a claim about the GIG payment, and a reversal that never touched a payments row has
-- no business filing one.
--
-- This file handles the RESIDUE — rows already written since 2026-08-14 — and it does not
-- pretend to a precision it lacks. A tip-sourced row is INDISTINGUISHABLE by shape from a
-- genuine one: the reason carries a Stripe charge id (ch_/py_) or dispute id (dp_/du_),
-- while payments stores the PaymentIntent id, so there is no key to join on and no way to
-- retro-mark the rows. So the control is NOT taught to suppress them. Suppressing on a
-- heuristic would trade a false positive for a false NEGATIVE on a money control, and a
-- reversal a human never hears about is the worse of the two failures.
--
-- Instead: when the reversal is fully explained by a REVERSED TIP on the same booking, the
-- finding still fires — a human still looks — but the detail says so and withholds the
-- destructive instruction. The operator is told to confirm which Stripe object was
-- reversed and, if it was the tip, that tip_ledger already holds it and the gig payment
-- must not be touched. That is the honest shape: the control keeps reporting everything it
-- cannot explain, and stops printing a remedy that is wrong for one explicable case.
--
-- Nothing else about the control changes: the same anchored templates, the same join, the
-- same threshold, the same arithmetic.
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
           as reversal_cents
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
),
-- How much of this booking's TIP money has been reversed. Only a tip that was actually
-- reversed counts; a live tip explains nothing. This is a hint for the operator, never a
-- filter: it changes what the remedy SAYS, not which rows are returned.
tip_rev as (
  select t.booking_id,
         sum(coalesce(t.reversed_cents, 0))::bigint as reversed_cents
    from public.tip_ledger t
   where coalesce(t.reversed_cents, 0) > 0
     and t.reversed_at is not null
   group by t.booking_id
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
    'tip_reversed_cents', coalesce(tr.reversed_cents, 0),
    'basil_note', 'partial-capture releases no longer appear in amount_refunded '
                  '(Stripe 2025-03-31.basil), so this figure is compared raw. Correct '
                  'only while the API version pin is 2026-07-29.dahlia.',
    -- The STANDARD remedy stays first and unchanged — it is the one that is right for
    -- almost every finding, and __tests__/refundAttribution.test.js polices its wording.
    -- The tip branch below is the narrow exception.
    'remedy',
      case
        when not (
               coalesce(tr.reversed_cents, -1) = coalesce(d.reversal_cents, -2)
           and coalesce(p.refunded_cents, 0) = 0
             )
        then 'The money ALREADY moved at Stripe — this is a bookkeeping gap, not a refund '
             'to issue. Use admin console -> booking -> Record chargeback, which writes '
             'refunded_cents WITHOUT calling Stripe. Do NOT press Refund: that creates a '
             'SECOND real refund (reverse_transfer:true), and because our refunded_cents is '
             '0 here both its cap and its idempotency key are computed from a ledger that '
             'does not know about the Stripe-side refund, so nothing stops it. Note Record '
             'chargeback does not debit the earner (20260813160000 — the platform absorbs a '
             'destination-charge reversal); reconcile the earner separately if the money was '
             'genuinely recovered from them.'
        -- Otherwise: the reversal figure is exactly accounted for by a reversed TIP on this
        -- booking, and the gig payment shows no refund of its own. Until 2026-09-06
        -- stripe-webhook filed a disputes row for a reversed tip against the GIG's booking
        -- in this same template, and such a row is indistinguishable from a real one by
        -- shape — the reason carries a charge or dispute id while payments stores the
        -- PaymentIntent id, so there is no key to join on. The finding is still raised;
        -- only the instruction changes.
        else 'LIKELY A REVERSED TIP, NOT A GIG REFUND. This booking has $' ||
             to_char(tr.reversed_cents / 100.0, 'FM999999990.00') ||
             ' of TIP already reversed in tip_ledger — exactly the figure in this dispute '
             'row — and the gig payment shows no refund at all. Until 2026-09-06 '
             'stripe-webhook filed a disputes row for a reversed tip against the gig''s '
             'booking in this same template. CHECK THE STRIPE OBJECT ID IN dispute_reason: '
             'if it belongs to the TIP''s PaymentIntent, the money is ALREADY ledgered in '
             'tip_ledger.reversed_cents (which ctl_earnings_total_drift subtracts) and there '
             'is nothing to record — resolve the dispute row and leave the payment alone. '
             'Do NOT press Record chargeback here: it writes refunded_cents onto a gig '
             'charge nobody refunded, which makes the poster''s receipt read "Refunded to '
             'you" on work they paid for, and makes vest_bonuses void any referral bonus '
             'sourced from this booking. Only if the id belongs to the GIG''s PaymentIntent '
             'does the standard remedy apply.'
      end
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join reversal d on d.booking_id = p.booking_id
left join tip_rev tr on tr.booking_id = p.booking_id
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


-- ── Prove it discriminates on the same staged rows ──────────────────────────
-- Broken vs fixed on one booking: a tip-shaped reversal must still be REPORTED (never
-- silently dropped — that would be a false negative on a money control) and must carry
-- the tip-aware remedy, while a genuine unledgered gig refund keeps the destructive-but-
-- correct one. Everything is rolled back.
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  n int; rem text; tipc bigint;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'tip reversal control probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;

  -- A CAPTURED gig payment that was never refunded. This is the row the control reports
  -- on, and the row the printed remedy would have corrupted.
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at)
  values (bid, 'pi_probe_gig_' || substr(md5(random()::text), 1, 12),
          10000, 700, 9300, 0, 'captured', now())
  returning id into pid;

  -- A $20 tip on the same booking, fully reversed. record_tip_reversal's own effect.
  insert into public.tip_ledger
    (booking_id, payment_intent_id, earner_id, amount_cents, reversed_cents, reversed_at)
  values (bid, 'pi_probe_tip_' || substr(md5(random()::text), 1, 12), uid, 2000, 2000, now());

  -- The row the OLD stripe-webhook wrote: the TIP's charge id, in the gig template, on
  -- the gig's booking. Aged past the control's 24-hour threshold.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid,
          'Stripe refund on charge ch_probeTIPcharge01 (usd 20.00 refunded)',
          now() - interval '30 hours');

  -- IT STILL FIRES. Suppressing would be a false negative, and a reversal nobody hears
  -- about is worse than one described awkwardly.
  select count(*) into n from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n <> 1 then
    raise exception 'a tip-shaped reversal must still be REPORTED, got % rows', n;
  end if;
  raise notice 'still reported: the control never goes quiet about a reversal it cannot explain';

  -- …and the remedy no longer tells the operator to corrupt the gig ledger.
  select detail->>'remedy', (detail->>'tip_reversed_cents')::bigint
    into rem, tipc
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if rem not like 'LIKELY A REVERSED TIP%' then
    raise exception 'FIX FAILED: tip-explained reversal still printed the gig remedy: %', left(rem, 120);
  end if;
  -- The destructive imperative must be GONE from this branch, not merely followed by a
  -- caveat. An operator reading "Use admin console -> Record chargeback" acts on it.
  if rem like '%Use admin console -> booking -> Record chargeback%' then
    raise exception 'FIX FAILED: the tip branch still instructs Record chargeback';
  end if;
  if rem not like '%Do NOT press Record chargeback%' then
    raise exception 'FIX FAILED: the tip branch does not warn against Record chargeback';
  end if;
  if coalesce(tipc, 0) <> 2000 then
    raise exception 'the tip figure the operator needs is missing (got %)', tipc;
  end if;
  raise notice 'discriminates: the tip case names tip_ledger and refuses Record chargeback';

  -- THE OTHER HALF. Same booking, same shapes — but the reversal is bigger than any tip
  -- on it, so it is a genuine unledgered gig reversal and the standard remedy must stand.
  update public.disputes
     set reason = 'Stripe refund on charge ch_probeGIGcharge1 (usd 45.00 refunded)'
   where booking_id = bid;

  select detail->>'remedy' into rem
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if rem is null then
    raise exception 'a genuine unledgered gig reversal stopped being reported';
  end if;
  if rem like 'LIKELY A REVERSED TIP%' then
    raise exception 'FIX TOO WIDE: a real gig reversal was excused as a tip';
  end if;
  if rem not like '%Record chargeback%' then
    raise exception 'the standard remedy was lost for the case it is correct for';
  end if;
  raise notice 'a real gig reversal keeps the standard remedy — the narrowing did not swallow it';

  -- And a booking with NO reversed tip at all cannot reach the tip branch.
  update public.tip_ledger set reversed_cents = 0, reversed_at = null where booking_id = bid;
  update public.disputes
     set reason = 'Stripe refund on charge ch_probeTIPcharge01 (usd 20.00 refunded)'
   where booking_id = bid;
  select detail->>'remedy' into rem
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if rem like 'LIKELY A REVERSED TIP%' then
    raise exception 'excused as a tip on a booking whose tip was never reversed';
  end if;
  raise notice 'no reversed tip, no tip excuse — the hint is data-driven, not a guess';

  if not exists (select 1 from public.controls
                  where key = 'external_reversal_not_ledgered' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'tip-vs-gig reversal probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
