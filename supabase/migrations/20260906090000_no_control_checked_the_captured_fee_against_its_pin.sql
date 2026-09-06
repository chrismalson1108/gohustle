-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing ever checked a captured fee against the rate it was pinned at.
--
-- CLAUDE.md's money obligation is explicit: anything touching payments needs "a control
-- asserting the invariant against DATA rather than against the formula". The whole point
-- of pinning four immutable inputs on the payment row — amount_cents, fee_bps,
-- fee_credit_cents, poster_discount_cents (trg_z_pin_payment_fee_bps, 20260806050000 and
-- 20260806110000) — is that the fee stays re-derivable from them at any later moment.
-- Nothing re-derived it.
--
-- ctl_payment_ledger_impossible (20260806040000:73) is the only control that reads
-- payments.fee_cents at all, and it reads it as an ADDEND: captured <= authorized,
-- refunded <= captured, refunded-without-capture, credited-without-capture, and
-- non-negative amounts. Every one of those tests is satisfied by a fee that is simply
-- the WRONG NUMBER, because the earner's side absorbs the difference and the two halves
-- still sum to what Stripe collected. Walking every ctl_* body in the migration tree,
-- fee_bps appears only in ctl_poster_discount_underwater, ctl_fee_tier_below_floor,
-- ctl_fee_tier_ladder_inverted and the discount/promotion controls — all of which inspect
-- bookings, fee_tiers or promo grants. Not one of them looks at payments.fee_cents.
--
-- So both fee bugs this platform has already shipped would have been invisible:
--   · `Number(null) === 0` resolving a NULL rate to a free gig — fee_cents 0 on a real
--     capture. Sums fine. Silent.
--   · the fee x pct^2 retry the capture code's own comments warn about
--     (stripe-capture-payment/index.ts:351-358): a first partial attempt persists the
--     reduced fee and then fails, and a retry that read the mutable fee_cents would scale
--     the already-reduced value a second time. A $200 gig at 700 bps settled at 50%
--     records 350c instead of 700c. It clears the 345c Stripe floor, and it sums to the
--     10000c Stripe collected — so ctl_payment_ledger_impossible passes, reconcile-stripe's
--     captured_total_mismatch passes, and ctl_earnings_total_drift compares profiles
--     against the same inflated earner column. The platform under-collects on every
--     retried partial capture and the board stays green.
--
-- ── WHY A BAND AND NOT AN EQUALITY ──────────────────────────────────────────
-- Four live paths write fee_cents and they do NOT agree to the cent, so a control
-- demanding one number would be permanent noise — the failure this project has already
-- fixed three times. The band spans every derivation that is legitimately in production:
--
--   cand_capture — stripe-capture-payment. Full: max(0, fee_after_credit(gig) - discount).
--                  Partial: min(K, max(round(fullFee * K/A), floor(K))), including the
--                  re-floor at the CAPTURED amount (index.ts:381-393).
--   cand_claim   — earner-claim-payment:294-302 and admin-payment-action:238-246, whose
--                  recompute fallback is fee_after_credit(captured + discount) and which,
--                  unlike the capture path, does NOT subtract the poster discount again.
--
-- The poster discount is funded OUT of the fee AFTER the floor is applied
-- (stripe-create-payment-intent writes fee_cents = feeAfterCredit - discount), so a
-- legitimate fee can sit BELOW platform_fee_cents(captured, 0). A control that used the
-- processing floor as its lower bound — the obvious shape — would fire on every
-- discounted booking. Probe D stages exactly that row; probe E shows the equally obvious
-- upper bound, platform_fee_cents(captured, fee_bps), firing on the earner-claim
-- derivation of the same booking while this control stays silent on both.
--
-- +/-2c of slack absorbs the rounding: the code scales by the caller's pct while this
-- re-derives it as K/A, and K is itself round(A * pct).
--
-- Refunds do not disturb any of this. Nothing in SQL and nothing on the refund paths
-- rewrites fee_cents or earner_amount_cents — a reversal moves refunded_cents only — so a
-- refunded row still carries the split that was captured.
--
-- NOT FIXED HERE, and deliberately inside the band rather than outside it:
-- earner-claim-payment's recompute fallback omits the `- discount` that the capture path
-- applies, so an earner who self-settles a discounted booking is charged up to
-- poster_discount_cents more fee than the poster's own verify would have taken. That is a
-- defect in a money path, not in the detection of it; narrowing the band to catch it would
-- make this control fire on live rows that are correct by the code as it stands. Recorded
-- here so the next session has it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_captured_fee_off_pin()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$
with base as (
  select
    p.id,
    p.booking_id,
    p.payment_intent_id,
    coalesce(p.amount_cents, 0)                                     as authorized_cents,
    coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0)   as captured_cents,
    coalesce(p.fee_cents, 0)                                        as fee_cents,
    coalesce(p.earner_amount_cents, 0)                              as earner_amount_cents,
    coalesce(p.refunded_cents, 0)                                   as refunded_cents,
    -- The same rate resolution the four money paths use, so this cannot disagree with
    -- them about a missing or out-of-range pin.
    public.safe_fee_bps(p.fee_bps)                                  as fee_bps,
    greatest(0, coalesce(p.fee_credit_cents, 0))                    as credit_cents,
    greatest(0, coalesce(p.poster_discount_cents, 0))               as discount_cents,
    p.captured_at
  from public.payments p
  where p.status = 'captured'
),
derived as (
  select b.*,
    -- The fee on the WHOLE authorization, from the pinned inputs only. amount_cents is
    -- the poster's charge, i.e. the gig NET of the discount, so the gig value is
    -- amount_cents + poster_discount_cents — exactly what the capture path reconstructs.
    greatest(0, public.platform_fee_after_credit(
      b.authorized_cents + b.discount_cents, b.fee_bps, b.credit_cents
    ) - b.discount_cents) as full_fee_cents
  from base b
  where b.authorized_cents > 0
    and b.captured_cents > 0
),
banded as (
  select d.*,
    case when d.captured_cents >= d.authorized_cents
         then d.full_fee_cents
         else least(d.captured_cents, greatest(
                round(d.full_fee_cents::numeric * d.captured_cents / d.authorized_cents)::integer,
                public.platform_fee_cents(d.captured_cents, 0)))
    end as cand_capture,
    least(d.captured_cents, public.platform_fee_after_credit(
      d.captured_cents + d.discount_cents, d.fee_bps, d.credit_cents
    )) as cand_claim
  from derived d
)
select
  b.id::text as entity_id,
  jsonb_build_object(
    'kind', case when b.fee_cents < least(b.cand_capture, b.cand_claim)
                 then 'fee_below_pin' else 'fee_above_pin' end,
    'booking_id', b.booking_id,
    'payment_intent_id', b.payment_intent_id,
    'fee_cents', b.fee_cents,
    'expected_low_cents', least(b.cand_capture, b.cand_claim),
    'expected_high_cents', greatest(b.cand_capture, b.cand_claim),
    'off_by_cents', case when b.fee_cents < least(b.cand_capture, b.cand_claim)
                         then b.fee_cents - least(b.cand_capture, b.cand_claim)
                         else b.fee_cents - greatest(b.cand_capture, b.cand_claim) end,
    'authorized_cents', b.authorized_cents,
    'captured_cents', b.captured_cents,
    'earner_amount_cents', b.earner_amount_cents,
    'refunded_cents', b.refunded_cents,
    'pinned_fee_bps', b.fee_bps,
    'pinned_fee_credit_cents', b.credit_cents,
    'pinned_poster_discount_cents', b.discount_cents,
    'captured_at', b.captured_at,
    'note', 'the fee recorded on a captured payment is not the fee its OWN pinned inputs '
            'imply. fee_bps, fee_credit_cents and poster_discount_cents are immutable from '
            'authorization, so the fee is re-derivable at any time; this row is not '
            'derivable from them. Below the band means the platform under-collected and '
            'the earner was over-credited — the fee x pct^2 shape a partial-capture retry '
            'produces, or a rate that resolved to zero. Above it means the earner was '
            'short-paid, most often a capture performed OUTSIDE this platform, where '
            'Stripe applies the FULL authorization fee to a reduced capture.',
    'remedy', 'Reconcile against Stripe first: the charge''s application_fee_amount and '
              'amount_received are what actually moved. If Stripe agrees with the band and '
              'the ledger does not, correct fee_cents and earner_amount_cents together so '
              'they still sum to amount_received, and check whether credit_earnings has '
              'already paid out on the wrong figure. If Stripe agrees with the LEDGER, the '
              'fee really was mis-applied at capture and the difference is owed to '
              'whichever side lost it.'
  ) as detail
from banded b
where b.fee_cents < least(b.cand_capture, b.cand_claim) - 2
   or b.fee_cents > greatest(b.cand_capture, b.cand_claim) + 2
$ctl$;

revoke execute on function public.ctl_captured_fee_off_pin() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('captured_fee_off_pin',
   'A captured fee that its own pinned inputs do not imply',
   'high', 'money',
   'The fee is pinned per booking (fee_bps, fee_credit_cents, poster_discount_cents) so '
   'that capture is idempotent and the fee stays re-derivable forever. Nothing re-derived '
   'it. ctl_payment_ledger_impossible reads fee_cents only as an addend — sums and signs — '
   'so a fee that is simply the wrong number passes it: the earner''s side absorbs the '
   'difference and the two halves still sum to what Stripe collected. Both fee bugs this '
   'platform has shipped land in that blind spot — a NULL rate resolving to a free gig, '
   'and the fee x pct^2 a partial-capture retry produces (a $200 gig at 700 bps settled at '
   '50% recording 350c instead of 700c, above the Stripe floor and therefore '
   'arithmetically possible). Fires outside a band spanning every derivation live today, '
   'so a legitimately discounted or floor-dominated capture cannot cry wolf.',
   'ctl_captured_fee_off_pin')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it discriminates, on staged rows, rolled back ─────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  jid2 uuid; bid2 uuid; pid2 uuid;
  n_new int; n_old int; naive int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- ═══ A. A healthy FULL capture is silent ═══════════════════════════════════
  -- $100 gig at 700 bps, no credit, no discount: fee 700c (the percentage beats the
  -- 345c floor), earner 9300c.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'captured fee pin probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  -- The payment INSERT trigger copies these three off the booking, so they must be
  -- staged there rather than on the payment — and its UPDATE branch restores the old
  -- values, so they cannot be changed on the payment row afterwards either.
  update public.bookings
     set fee_bps_quoted = 700, fee_credit_cents = 0, poster_discount_cents = 0
   where id = bid;
  -- pin_booking_amount ran consume_fee_credit on the INSERT above and may have attached
  -- one of this profile's real payable credits to the probe booking. Detach it.
  delete from public.bonus_ledger where applied_booking_id = bid;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values (bid, 'pi_fee_pin_probe_plain', 10000, 700, 9300, 0, 'captured', now(), true)
  returning id into pid;

  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'fired on a correct full capture — this would be permanent noise (% rows)', n_new;
  end if;
  raise notice 'A: a correct full capture at the pinned rate is silent';

  -- ═══ B. The NULL-rate bug: a real capture recorded at zero fee ═════════════
  update public.payments set fee_cents = 0, earner_amount_cents = 10000 where id = pid;
  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a zero fee on a 700 bps capture reported % rows', n_new;
  end if;
  -- THE DISCRIMINATION: the only control that reads fee_cents today cannot see it.
  select count(*) into n_old from public.ctl_payment_ledger_impossible() where entity_id = pid::text;
  if n_old <> 0 then
    raise exception 'ctl_payment_ledger_impossible already covered a zero fee; the new control is redundant';
  end if;
  raise notice 'B: zero fee on a real capture — new control sees it (% row), ctl_payment_ledger_impossible sees %', n_new, n_old;

  -- ═══ C. The fee x pct^2 retry, the shape the capture code warns about ══════
  -- $200 gig at 700 bps settled at 50%: 10000c captured, correct fee 700c.
  update public.payments set amount_cents = 20000, fee_cents = 700, earner_amount_cents = 9300 where id = pid;
  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'fired on a correct 50%% partial capture (% rows)', n_new;
  end if;
  raise notice 'C1: a correct partial capture is silent';

  -- The retry scales the already-reduced fee a second time: 350c, not 700c.
  update public.payments set fee_cents = 350, earner_amount_cents = 9650 where id = pid;
  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: the fee x pct^2 shape reported % rows', n_new;
  end if;
  select count(*) into n_old from public.ctl_payment_ledger_impossible() where entity_id = pid::text;
  if n_old <> 0 then
    raise exception 'ctl_payment_ledger_impossible already covered the pct^2 shape; the new control is redundant';
  end if;
  -- And the bound first proposed for this control — the Stripe processing floor — would
  -- NOT have caught it: 350c clears the 345c floor on a 10000c capture.
  select public.platform_fee_cents(10000, 0) into naive;
  if 350 < naive then
    raise exception 'the floor-only bound would have caught this; the band is not what makes it work';
  end if;
  raise notice 'C2: 350c instead of 700c — new control fires, ledger_impossible sees %, and the %c processing floor clears it', n_old, naive;

  -- ═══ D. A poster discount must NOT cry wolf ════════════════════════════════
  -- $100 gig at 700 bps with a 355c poster discount: the poster is charged 9645c, and the
  -- discount is funded out of the fee AFTER the floor, so the fee is 345c. A control
  -- floored at platform_fee_cents(captured, 0) reckoned on the gig would fire on every
  -- discounted booking. A second booking, because the discount is pinned at payment
  -- INSERT and cannot be updated onto the row above.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'captured fee pin discount probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, uid, 'verified')
  returning id into bid2;
  update public.bookings
     set fee_bps_quoted = 700, fee_credit_cents = 0, poster_discount_cents = 355
   where id = bid2;
  delete from public.bonus_ledger where applied_booking_id = bid2;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values (bid2, 'pi_fee_pin_probe_discount', 9645, 345, 9300, 0, 'captured', now(), true)
  returning id into pid2;
  if (select poster_discount_cents from public.payments where id = pid2) <> 355 then
    raise exception 'staging drifted: the discount did not pin onto the payment row';
  end if;

  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid2::text;
  if n_new <> 0 then
    raise exception 'fired on a legitimately discounted capture — cry wolf (% rows)', n_new;
  end if;
  raise notice 'D: a 355c poster discount funded out of the fee stays off the board';

  -- ═══ E. The earner-claim derivation must NOT cry wolf either ═══════════════
  -- The same booking settled by earner-claim-payment's recompute fallback, which does not
  -- subtract the discount a second time: 700c, not 345c. Both are live today, so both sit
  -- inside the band — while the naive upper bound, platform_fee_cents(captured, fee_bps),
  -- would have fired on it.
  update public.payments set fee_cents = 700, earner_amount_cents = 8945 where id = pid2;
  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid2::text;
  if n_new <> 0 then
    raise exception 'fired on the earner-claim derivation of a discounted capture (% rows)', n_new;
  end if;
  select public.platform_fee_cents(9645, 700) into naive;
  if 700 <= naive then
    raise exception 'the naive upper bound would not have fired here — probe E no longer makes its point';
  end if;
  raise notice 'E: earner-claim wrote 700c on a discounted capture; silent here, while the naive %c ceiling would have fired', naive;

  -- ═══ F. A doubled fee — the earner short-paid — is caught too ══════════════
  update public.payments
     set amount_cents = 10000, fee_cents = 1400, earner_amount_cents = 8600
   where id = pid;
  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a doubled fee reported % rows', n_new;
  end if;
  if (select detail->>'kind' from public.ctl_captured_fee_off_pin() where entity_id = pid::text)
     <> 'fee_above_pin' then
    raise exception 'a doubled fee was not reported as fee_above_pin';
  end if;
  raise notice 'F: a doubled fee is reported as fee_above_pin, so the earner''s side is watched as well as ours';

  -- ═══ G. Correcting the row resolves the finding ════════════════════════════
  update public.payments set fee_cents = 700, earner_amount_cents = 9300 where id = pid;
  select count(*) into n_new from public.ctl_captured_fee_off_pin() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'still open after correction — this finding could never auto-resolve';
  end if;
  raise notice 'G: correcting the split closes the finding rather than accumulating one';

  -- One row per payment. A control that names one entity twice errors instead of filing.
  if exists (select entity_id from public.ctl_captured_fee_off_pin()
              group by entity_id having count(*) > 1) then
    raise exception 'returns a duplicate entity_id — the finding upsert would error';
  end if;

  if not exists (select 1 from public.controls
                  where key = 'captured_fee_off_pin' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'captured-fee-off-pin probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
