-- ─────────────────────────────────────────────────────────────────────────────
-- My Stripe upgrade blinded a money control, and I only fixed half of it.
--
-- Earlier today I removed reconcile-stripe's pre-Basil compensation: Stripe's
-- 2025-03-31.basil release stopped updating charge.amount_refunded on partial capture,
-- so subtracting the auto-released remainder over-subtracts and hides real refunds.
--
-- ctl_external_reversal_not_ledgered carries the SAME assumption, in SQL, and I did not
-- touch it. CLAUDE.md's own rule — "after ANY fix, ask what else touched that code
-- path" — exists because of exactly this, and I walked into it anyway.
--
-- ── WHAT IT DOES WRONG NOW ──────────────────────────────────────────────────
--
--   released_cents = amount_cents - (earner_amount_cents + fee_cents)     -- the gap
--   fires when:  reversal_cents > released_cents + refunded_cents
--
-- `reversal_cents` is parsed from the disputes row the webhook wrote out of
-- charge.amount_refunded. Pre-Basil that figure INCLUDED the auto-released remainder,
-- so subtracting it was right. Post-Basil it does not, so the threshold is inflated by
-- the whole partial-capture gap and the control UNDER-REPORTS.
--
-- Concretely: a $100 hold captured at $60 has released_cents = 4000. A $35 Dashboard
-- refund that never reached our ledger produces reversal_cents = 3500, which is NOT
-- greater than 4000 + 0 — so no finding. The platform's books say it collected money it
-- no longer has, the earner's earnings_total is never debited, and the control that
-- exists to catch precisely that reports green.
--
-- This is the second half of the same bug, and the more dangerous half: reconcile-stripe
-- is a cross-check, but this control IS the detector for reversals issued outside the
-- console.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- Drop the compensation. Under the version we now pin, amount_refunded means genuine
-- refunds and nothing else, so the reversal figure needs no adjustment. Correctness
-- therefore DEPENDS on the API version pin — which is why
-- __tests__/stripeApiVersion.test.js failing on a pin change is load-bearing.
--
-- Safe outright rather than straddling both behaviours: production has zero partial
-- captures (verified), so no historical row carries a pre-Basil figure to misread.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_external_reversal_not_ledgered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $function$
with reversal as (
  select d.booking_id,
         d.created_at,
         d.resolved_at,
         -- Chargeback reasons do not carry a cents figure and parse to NULL, which
         -- takes the refunded_cents branch in the WHERE below.
         nullif(substring(d.reason from 'reversal_cents=([0-9]+)'), '')::bigint as reversal_cents
    from public.disputes d
   where d.reason like '%reversal_cents=%'
      or d.reason ilike '%chargeback%'
)
select p.id::text,
  jsonb_build_object(
    'booking_id', p.booking_id,
    'payment_intent_id', p.payment_intent_id,
    'authorized_cents', p.amount_cents,
    'captured_total_cents', coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0),
    'reversal_cents', d.reversal_cents,
    'refunded_cents', coalesce(p.refunded_cents, 0),
    'unledgered_cents',
      case when d.reversal_cents is null then null
           else d.reversal_cents - coalesce(p.refunded_cents, 0) end,
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

-- ── Prove the fix DISCRIMINATES: broken vs fixed on the same staged row ─────
do $$
declare
  bid uuid; pid uuid; jid uuid; uid uuid; n_fixed int; n_broken int;
  released bigint;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles limit 1;

  -- A $100 hold captured at $60 → released gap 4000. A $35 refund never ledgered.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'ctl probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status)
  values (jid, uid, 'verified') returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at)
  values (bid, 'pi_ctl_probe', 10000, 420, 5580, 0, 'captured', now()) returning id into pid;
  -- Backdated: the control deliberately ignores disputes younger than 24h, which is a
  -- grace period for an admin to record the reversal. A same-second probe tests nothing.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, 'external refund reversal_cents=3500', now() - interval '48 hours');

  select count(*) into n_fixed from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;

  -- What the OLD predicate would have returned on this same row.
  released := 10000 - (5580 + 420);
  select count(*) into n_broken from (select 1 where 3500 > released + 0) x;

  if n_broken <> 0 then
    raise exception 'probe is not discriminating: the old predicate also fired';
  end if;
  if n_fixed <> 1 then
    raise exception 'FIX FAILED: an unledgered $35 refund on a partial capture is still invisible (got % rows)', n_fixed;
  end if;
  raise notice 'discriminates: old predicate found 0, fixed control found 1 on the same row';

  -- And it must NOT fire when the refund IS ledgered.
  update public.payments set refunded_cents = 3500 where id = pid;
  select count(*) into n_fixed from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_fixed <> 0 then
    raise exception 'FALSE POSITIVE: fired on a correctly-ledgered refund';
  end if;
  raise notice 'no false positive when the refund is ledgered';

  delete from public.disputes where booking_id = bid;
  delete from public.payments where id = pid;
  delete from public.bookings where id = bid;
  delete from public.jobs where id = jid;
end $$;
