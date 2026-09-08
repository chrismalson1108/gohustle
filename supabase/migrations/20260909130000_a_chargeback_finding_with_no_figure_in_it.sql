-- A chargeback finding arrived with no figure in it.
--
-- ctl_external_reversal_not_ledgered extracts the reversed amount out of the dispute
-- row's machine template. There are TWO templates and it only ever matched one:
--
--   refund      Stripe refund on charge ch_... (usd 40.00 refunded)     -> ' refunded)'
--   chargeback  Stripe chargeback du_... (fraudulent, usd 100.00)       -> no match
--
-- So every CHARGEBACK finding carried `reversal_cents: null`, and therefore
-- `unledgered_cents: null`. The control still FIRED — the WHERE has an arm for a null
-- reversal against a zero refunded_cents — so nothing was missed and the remedy text was
-- right. But the operator opened a critical money finding that did not say how much money.
--
-- Verified against a REAL Stripe chargeback on 2026-09-08: du_... for usd 100.00, aged
-- past the control's 24-hour grace, reported `unledgered=<NULL> reversal=<NULL>
-- refunded=0`. The amount was sitting in the reason string the whole time.
--
-- Everything else in the function is unchanged; only the extraction gains a fallback.

CREATE OR REPLACE FUNCTION public.ctl_external_reversal_not_ledgered()
 RETURNS TABLE(entity_id text, detail jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with reversal as (
  select distinct on (dd.booking_id)
         dd.booking_id,
         dd.id,
         dd.reason,
         dd.created_at,
         dd.resolved_at,
         -- TWO templates, TWO shapes. The refund one ends '… usd 40.00 refunded)';
         -- the chargeback one ends '… (fraudulent, usd 100.00)'. This pattern only ever
         -- matched the first, so every CHARGEBACK finding carried reversal_cents NULL and
         -- therefore unledgered_cents NULL — a money finding with no figure in it, on the
         -- one reversal class the platform absorbs itself. Verified against a real Stripe
         -- chargeback 2026-09-08. Fall back to the chargeback shape.
         round(coalesce(
           substring(dd.reason from '([0-9]+\.[0-9]{2}) refunded\)'),
           substring(dd.reason from 'usd ([0-9]+\.[0-9]{2})\)$')
         )::numeric * 100)::bigint
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

-- ── Probe: both templates yield a figure; free text is still ignored ───────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; d_id uuid;
  cents bigint; n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 130000', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'verified', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at, captured_at)
  values (bid, 10000, 700, 9300, 'captured', 'pi_probe_130000',
          now() - interval '30 hours', now() - interval '30 hours', now() - interval '30 hours');

  -- The CHARGEBACK template — the one that used to yield nothing.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, poster, 'Stripe chargeback du_probe130abcd (fraudulent, usd 100.00)',
          now() - interval '25 hours') returning id into d_id;
  select (detail->>'reversal_cents')::bigint into cents
    from public.ctl_external_reversal_not_ledgered()
   where entity_id in (select id::text from public.payments where booking_id = bid);
  if cents is distinct from 10000 then
    raise exception 'FIX FAILED: a chargeback still reports reversal_cents = %',
      coalesce(cents::text, 'NULL');
  end if;
  delete from public.disputes where id = d_id;

  -- The REFUND template must be untouched.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, poster, 'Stripe refund on charge ch_probe130abcd (usd 40.00 refunded)',
          now() - interval '25 hours') returning id into d_id;
  select (detail->>'reversal_cents')::bigint into cents
    from public.ctl_external_reversal_not_ledgered()
   where entity_id in (select id::text from public.payments where booking_id = bid);
  if cents is distinct from 4000 then
    raise exception 'FIX FAILED: the refund template regressed to %', coalesce(cents::text, 'NULL');
  end if;
  delete from public.disputes where id = d_id;

  -- A poster's free text must STILL be ignored. The anchored patterns are the only thing
  -- separating stripe-webhook's template from a typed note, and a note can say anything.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, created_at)
  values (bid, poster, 'they left usd 40.00 refunded on the table', 75, now() - interval '25 hours');
  select count(*) into n from public.ctl_external_reversal_not_ledgered()
   where entity_id in (select id::text from public.payments where booking_id = bid);
  if n <> 0 then
    raise exception 'CONTROL WRONG: a poster''s typed reason was read as a Stripe reversal';
  end if;

  raise notice 'probe: both templates yield a figure, free text still ignored';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
