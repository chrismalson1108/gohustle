-- ─────────────────────────────────────────────────────────────────────────────
-- The Basil fix swapped this control's parser for one that matches nothing we write.
--
-- Yesterday's 20260813120000 correctly dropped the pre-Basil `released_cents`
-- compensation. But it also rewrote the CTE that SELECTS the reversal rows, from
--
--     where d.reason ilike 'Stripe refund on charge%'          -- what we write
--        or d.reason ilike 'Stripe chargeback%'
--     ... substring(d.reason from '([0-9]+\.[0-9]{2}) refunded\)')::numeric * 100
--
-- to
--
--     where d.reason like '%reversal_cents=%'                  -- what nothing writes
--        or d.reason ilike '%chargeback%'
--     ... substring(d.reason from 'reversal_cents=([0-9]+)')
--
-- `reversal_cents=` appears nowhere in supabase/functions, admin/, web/ or src/.
-- stripe-webhook's recordReversal() writes exactly two shapes (index.ts:454,481):
--
--     charge.refunded        →  'Stripe refund on charge ch_x (usd 50.00 refunded)'
--     charge.dispute.created →  'Stripe chargeback dp_x (fraudulent, usd 60.00)'
--
-- The chargeback arm survived on `%chargeback%`. The REFUND arm matches no row that
-- has ever existed, so the rewrite did not narrow the blind spot from "unledgered
-- refunds smaller than the partial-capture gap" to zero — it widened it to EVERY
-- external refund, on every payment, partial capture or not. Strictly worse than the
-- bug it was fixing.
--
-- It passed its own discrimination probe because the probe staged
-- `'external refund reversal_cents=3500'` — a string production never produces. A probe
-- that invents its own input proves the parser reads the probe, not that it reads
-- reality. This one uses the webhook's literal template.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Restore the original matcher and cents parser (20260806040000, which read production
-- correctly), and KEEP the Basil correction — no `released_cents` subtraction. Those
-- were always two independent changes; only one of them was wanted.
--
-- Also restores `distinct on (booking_id) … order by created_at desc`, dropped in the
-- same rewrite: without it a booking carrying both a refund row and a chargeback row
-- joins twice and the control returns the same payment id as two findings.
--
-- Correctness still depends on the API version pin (post-Basil `amount_refunded`
-- excludes the auto-released remainder), which is what makes
-- __tests__/stripeApiVersion.test.js load-bearing. __tests__/reversalReasonParity.test.js
-- now closes the other half: the SQL patterns here are matched against the reason
-- strings stripe-webhook actually builds, so this cannot drift again in silence.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_external_reversal_not_ledgered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $function$
with reversal as (
  -- Only the reversal rows stripe-webhook's recordReversal() writes. One row per
  -- booking, newest first: charge.amount_refunded is CUMULATIVE, so the latest refund
  -- row already carries the total refunded.
  select distinct on (dd.booking_id)
         dd.booking_id,
         dd.id,
         dd.reason,
         dd.created_at,
         dd.resolved_at,
         -- charge.refunded reasons end "(usd 12.34 refunded)". Chargeback reasons do
         -- not match this shape, so they parse to NULL and take the refunded_cents
         -- branch in the WHERE below.
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
    'remedy', 'admin console -> booking -> Record chargeback (or Refund), so record_refund writes refunded_cents and debits the earner'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join reversal d on d.booking_id = p.booking_id
where p.status = 'captured'
  and d.created_at < now() - interval '24 hours'
  and (
        (d.reversal_cents is null and coalesce(p.refunded_cents, 0) = 0)
        or
        -- No released_cents subtraction: post-Basil the reversal figure contains only
        -- genuine refunds. Subtracting the partial-capture gap inflated this threshold
        -- and silently hid unledgered refunds smaller than the gap.
        (d.reversal_cents is not null
         and d.reversal_cents > coalesce(p.refunded_cents, 0))
      )
$function$;

revoke execute on function public.ctl_external_reversal_not_ledgered() from public, anon, authenticated;

-- ── Prove it DISCRIMINATES, on the string the webhook actually writes ────────
do $$
declare
  bid uuid; pid uuid; jid uuid; uid uuid;
  n_fixed int; n_yesterday int; n_ledgered int; n_chargeback int;
  -- stripe-webhook/index.ts:481, verbatim shape.
  real_refund_reason text := 'Stripe refund on charge ch_3AbCdEfGhIjKlMnO (usd 35.00 refunded)';
  real_chargeback_reason text := 'Stripe chargeback dp_1AbCdEfGhIjKlMnO (fraudulent, usd 60.00)';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles limit 1;

  -- A $100 hold captured at $60. A $35 Dashboard refund that never reached our ledger.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'ctl probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status)
  values (jid, uid, 'verified') returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at)
  values (bid, 'pi_ctl_probe_reason', 10000, 420, 5580, 0, 'captured', now()) returning id into pid;
  -- Backdated: the control ignores disputes younger than 24h (a grace period for an
  -- admin to record the reversal), so a same-second probe would test nothing.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, real_refund_reason, now() - interval '48 hours');

  select count(*) into n_fixed
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;

  -- What YESTERDAY's predicate would have returned on this same row: its CTE requires
  -- the reason to contain 'reversal_cents=' or 'chargeback', and this one contains
  -- neither, so the row never enters the join at all.
  select count(*) into n_yesterday
    from public.disputes dd
   where dd.booking_id = bid
     and (dd.reason like '%reversal_cents=%' or dd.reason ilike '%chargeback%');

  if n_yesterday <> 0 then
    raise exception 'probe is not discriminating: the shipped parser also matched this reason';
  end if;
  if n_fixed <> 1 then
    raise exception 'FIX FAILED: an unledgered $35 refund is still invisible (got % rows)', n_fixed;
  end if;
  raise notice 'discriminates: shipped parser matched 0 rows, fixed control found 1 on the same row';

  -- It must NOT fire once the refund IS ledgered.
  update public.payments set refunded_cents = 3500 where id = pid;
  select count(*) into n_ledgered
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_ledgered <> 0 then
    raise exception 'FALSE POSITIVE: fired on a correctly-ledgered refund';
  end if;
  raise notice 'no false positive when the refund is ledgered';

  -- And the chargeback arm must still work: no cents figure parses, so it fires on
  -- refunded_cents = 0. Newest-row-wins, so this replaces the refund row above.
  update public.payments set refunded_cents = 0 where id = pid;
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, real_chargeback_reason, now() - interval '24 hours' - interval '1 minute');
  select count(*) into n_chargeback
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_chargeback <> 1 then
    raise exception 'CHARGEBACK ARM BROKEN: expected 1 finding, got %', n_chargeback;
  end if;
  raise notice 'chargeback arm intact';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'reversal-reason probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
