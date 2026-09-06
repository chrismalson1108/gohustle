-- ─────────────────────────────────────────────────────────────────────────────
-- A partial refund on a discounted or partially-captured booking returns too little
-- fee credit — usually none of it.
--
-- 20260814130000 taught record_refund to hand back the unused part of an applied fee
-- credit, and it derives the credit's DELIVERED value like this (:131-137):
--
--   platform_fee_cents(amount_cents + poster_discount_cents, safe_fee_bps(fee_bps))
--     - fee_cents
--
-- then scales it by the surviving share of the capture. That expression is only correct
-- for a FULL capture with NO poster discount — which is the only case its probe staged,
-- so nothing caught it. Two things make it wrong otherwise, and both inflate it:
--
--  1. THE DISCOUNT. stripe-capture-payment writes fee_cents NET of the poster's discount
--     (`fullFeeForAuth = fullFeeCalc - discountCents`, index.ts:252, persisted at :427).
--     The left-hand term is not net of it. So the delivered figure comes out exactly
--     poster_discount_cents too high.
--
--  2. THE PARTIAL CAPTURE. On a capture below 100%, fee_cents is the fee scaled to the
--     CAPTURED amount (index.ts:311-313) while amount_cents deliberately stays the full
--     authorization (:319-320). So the left-hand term is the fee on the whole gig and the
--     right-hand term is the fee on the part that settled — the difference between them is
--     counted as credit the earner received, and they never did.
--
-- return_unused_fee_credit hands back `applied_total - delivered` and returns 0 when that
-- is negative (20260813130000:66-67). An inflated delivered figure therefore does not
-- over-return; it silently under-returns, and on the shapes above it usually returns
-- nothing at all. The earner loses part of a referral credit they spent seven days
-- vesting, on a booking the POSTER got refunded for.
--
-- ── THE FIX: ONE DEFINITION, NOT TWO ────────────────────────────────────────
--
-- stripe-capture-payment already computes this figure CORRECTLY at capture (index.ts:
-- 391-401): it nets the discount off both sides and re-floors the no-credit fee at the
-- captured amount. The refund path re-derived the same quantity a second, different way.
-- That is the failure the 20260814130000 header warned about one layer up — "a
-- credit-return that exists twice is a credit-return that disagrees with itself".
--
-- So the arithmetic moves into ONE place, public.fee_credit_delivered_cents(payment),
-- derived only from columns that cannot change after capture (amount_cents, fee_bps,
-- fee_credit_cents and poster_discount_cents are pinned; fee_cents and
-- earner_amount_cents are final once status='captured'). record_refund calls it, and
-- stripe-capture-payment calls the same RPC instead of its inline copy. Same rule as
-- platform_fee_cents: the fee has one definition and every path asks it.
--
-- Found by the recent-changes review of 20260814130000, 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The delivered value of an applied fee credit, on a captured payment ──────
--
-- "What the earner's fee would have been WITHOUT the credit, minus what they actually
-- paid." Mirrors stripe-capture-payment/index.ts:389-401 exactly, including the two
-- corrections the refund path was missing:
--
--   * the poster's discount is funded out of the platform's share, so it comes off the
--     no-credit fee as well as off fee_cents;
--   * on a partial capture the no-credit fee is scaled to what settled and re-floored at
--     Stripe's cost on that same captured amount, because the fixed 30c+25c does not
--     scale.
--
-- Reads the persisted split rather than recomputing it, so it agrees with whatever Stripe
-- actually collected (reconcileToStripe may have adjusted the split after the fact).
create or replace function public.fee_credit_delivered_cents(p_payment_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p                    record;
  v_captured           integer;
  v_disc               integer;
  v_bps                integer;
  v_gig                integer;
  v_no_credit_full     integer;
  v_no_credit_captured integer;
begin
  if p_payment_id is null then return 0; end if;

  select amount_cents, fee_cents, earner_amount_cents, poster_discount_cents, fee_bps
    into p
    from public.payments
   where id = p_payment_id;
  if not found then return 0; end if;

  -- What was actually collected. amount_cents is the AUTHORIZATION and is never
  -- rewritten, so on a partial capture the two differ and that difference is the whole
  -- point of this function.
  v_captured := coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0);
  if v_captured <= 0 or coalesce(p.amount_cents, 0) <= 0 then return 0; end if;

  v_disc := greatest(0, coalesce(p.poster_discount_cents, 0));
  v_bps  := public.safe_fee_bps(p.fee_bps);
  -- The original gig value: amount_cents is already net of the poster's discount.
  v_gig  := coalesce(p.amount_cents, 0) + v_disc;

  v_no_credit_full := greatest(0, public.platform_fee_cents(v_gig, v_bps) - v_disc);

  if v_captured >= coalesce(p.amount_cents, 0) then
    v_no_credit_captured := v_no_credit_full;
  else
    v_no_credit_captured := least(
      v_captured,
      greatest(
        round(v_no_credit_full::numeric * v_captured::numeric / p.amount_cents::numeric)::integer,
        -- The floor is on the CAPTURED amount: platform_fee_cents with 0 bps is exactly
        -- Stripe's cost plus the 25c margin, from the one definition of the fee.
        public.platform_fee_cents(v_captured, 0)
      )
    );
  end if;

  return greatest(0, v_no_credit_captured - coalesce(p.fee_cents, 0));
end;
$$;

comment on function public.fee_credit_delivered_cents(uuid) is
  'Cents of value an applied fee credit actually delivered on a captured payment: the '
  'no-credit fee at the captured amount (net of the poster discount, re-floored at '
  'Stripe cost) minus the fee charged. The ONE definition — stripe-capture-payment and '
  'record_refund both call it rather than deriving it twice.';

revoke execute on function public.fee_credit_delivered_cents(uuid) from public, anon, authenticated;
grant execute on function public.fee_credit_delivered_cents(uuid) to service_role;

-- ── record_refund: unchanged except for where the delivered figure comes from ─
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
  v_booking  uuid;
  v_credit   integer;
  v_returned integer;
begin
  select coalesce(earner_amount_cents, 0) + coalesce(fee_cents, 0), coalesce(refunded_cents, 0), booking_id
    into v_captured, v_already, v_booking
    from public.payments
   where id = p_payment_id
   for update;

  if v_captured is null then
    return null;
  end if;

  if v_already + p_cents > v_captured then
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
      update public.payments
         set refund_source = null, refund_source_at = null
       where id = p_payment_id;
      return v_already;
    end if;
  end if;

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

  -- ── Give the earner's fee credit back, in proportion to what was refunded ──
  --
  -- Deliberately AFTER the ledger writes and deliberately non-fatal: the money has already
  -- moved at Stripe, so a bookkeeping failure here must not roll back a refund the
  -- cardholder has been given. This mirrors how stripe-capture-payment treats the same
  -- call and how settle_booking_benefits is treated one layer up.
  if v_booking is not null and v_captured > 0 then
    begin
      -- What the credit was worth on this booking — from the ONE definition, which nets
      -- the poster discount off both sides and scales the no-credit fee to what was
      -- actually captured. Re-deriving it here is what made a partial refund on a
      -- discounted or partially-captured booking return nothing.
      -- The refund writes above touch refunded_cents only, so every input is still the
      -- post-capture value and this figure does not move between reversals.
      v_credit := public.fee_credit_delivered_cents(p_payment_id);

      v_returned := public.return_unused_fee_credit(
        v_booking,
        -- Delivered value AFTER this refund: scaled by the share of the capture that
        -- survives it. A full refund delivers nothing and returns the whole credit.
        greatest(0, round(coalesce(v_credit, 0)::numeric * (1 - v_new::numeric / v_captured))::integer)
      );
      if coalesce(v_returned, 0) > 0 then
        raise notice 'record_refund: returned %c of unused fee credit on booking %', v_returned, v_booking;
      end if;
    exception when others then
      raise warning 'fee credit return failed for booking %: %', v_booking, sqlerrm;
    end;
  end if;

  return v_new;
end;
$function$;

revoke execute on function public.record_refund(uuid, integer, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, integer, text, uuid, boolean, text) to service_role;

-- ── Prove it discriminates, on the two shapes the old probe never staged ─────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  delivered_new int; delivered_old int; returned int; payable int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- ═══ A. PARTIAL CAPTURE, no discount ══════════════════════════════════════
  -- $200 gig at 700 bps with a 765c credit, settled at 50%. From the capture path:
  --   fee without credit on the full gig 1400c; at 50% → 700c
  --   fee actually charged                345c (the Stripe floor on the 10000c captured)
  --   delivered                           355c   (410c already returned at capture)
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'partial capture credit probe', 'Odd Jobs', 200, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  -- The payment INSERT trigger copies these three off the booking, so they must be
  -- staged there rather than on the payment.
  update public.bookings
     set fee_bps_quoted = 700, fee_credit_cents = 765, poster_discount_cents = 0
   where id = bid;
  -- pin_booking_amount ran consume_fee_credit on the INSERT above and may have attached
  -- one of this profile's real payable credits to the probe booking. Detach it, or
  -- return_unused_fee_credit would be summing someone's actual ledger (rolled back with
  -- everything else here).
  delete from public.bonus_ledger where applied_booking_id = bid;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values (bid, 'pi_partial_credit_probe', 20000, 345, 9655, 0, 'captured', now(), true)
  returning id into pid;

  -- 355c of the 765c is still applied; the capture already returned the other 410c.
  insert into public.bonus_ledger (user_id, reason, amount_cents, state, delivery, applied_booking_id, applied_at)
  values (uid, 'probe_partial', 355, 'applied', 'credit', bid, now());

  select public.fee_credit_delivered_cents(pid) into delivered_new;
  if delivered_new <> 355 then
    raise exception 'delivered figure wrong on a partial capture: % (want 355)', delivered_new;
  end if;

  -- The OLD expression, evaluated on this same row.
  select greatest(0, public.platform_fee_cents(
           coalesce(amount_cents, 0) + coalesce(poster_discount_cents, 0),
           public.safe_fee_bps(fee_bps)) - coalesce(fee_cents, 0))
    into delivered_old from public.payments where id = pid;
  if delivered_old <> 1055 then
    raise exception 'staging drifted: the old expression yields % (want 1055)', delivered_old;
  end if;

  -- Half of the 10000c capture is refunded → half the delivered 355c survives.
  select public.record_refund(pid, 5000, 'probe half refund', uid, true, 're_partial_probe') into returned;
  select coalesce(sum(amount_cents), 0) into payable
    from public.bonus_ledger where user_id = uid and reason = 'probe_partial' and state = 'payable';
  if payable <> 177 then
    raise exception 'FIX FAILED: a half refund returned %c of the 355c applied credit (want 177)', payable;
  end if;
  -- DISCRIMINATION: the old figure scaled to 528c, which exceeds the 355c still applied,
  -- so return_unused_fee_credit's `if unused <= 0 then return 0` swallowed the lot.
  if round(delivered_old::numeric * 0.5)::integer <= 355 then
    raise exception 'the old expression would not have zeroed here — probe no longer discriminates';
  end if;
  raise notice 'partial capture: new returns 177c, old delivered %c > 355c applied so it returned 0c',
    round(delivered_old::numeric * 0.5)::integer;

  -- ═══ B. FULL CAPTURE with a poster discount ═══════════════════════════════
  -- $100 gig at 700 bps, 50c credit + 305c discount (both funded from the 355c headroom).
  --   fee without credit 700c, less the 305c discount → 395c
  --   fee charged        345c
  --   delivered           50c — the whole credit
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'discounted capture credit probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  update public.bookings
     set fee_bps_quoted = 700, fee_credit_cents = 50, poster_discount_cents = 305
   where id = bid;
  -- pin_booking_amount ran consume_fee_credit on the INSERT above and may have attached
  -- one of this profile's real payable credits to the probe booking. Detach it, or
  -- return_unused_fee_credit would be summing someone's actual ledger (rolled back with
  -- everything else here).
  delete from public.bonus_ledger where applied_booking_id = bid;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values (bid, 'pi_discount_credit_probe', 9695, 345, 9350, 0, 'captured', now(), true)
  returning id into pid;

  insert into public.bonus_ledger (user_id, reason, amount_cents, state, delivery, applied_booking_id, applied_at)
  values (uid, 'probe_discount', 50, 'applied', 'credit', bid, now());

  select public.fee_credit_delivered_cents(pid) into delivered_new;
  if delivered_new <> 50 then
    raise exception 'delivered figure wrong on a discounted capture: % (want 50)', delivered_new;
  end if;
  select greatest(0, public.platform_fee_cents(
           coalesce(amount_cents, 0) + coalesce(poster_discount_cents, 0),
           public.safe_fee_bps(fee_bps)) - coalesce(fee_cents, 0))
    into delivered_old from public.payments where id = pid;
  if delivered_old <> 355 then
    raise exception 'staging drifted: the old expression yields % (want 355)', delivered_old;
  end if;

  select public.record_refund(pid, 4847, 'probe half refund', uid, true, 're_discount_probe') into returned;
  select coalesce(sum(amount_cents), 0) into payable
    from public.bonus_ledger where user_id = uid and reason = 'probe_discount' and state = 'payable';
  if payable <> 25 then
    raise exception 'FIX FAILED: a half refund on a discounted booking returned %c of 50c (want 25)', payable;
  end if;
  if round(delivered_old::numeric * (1 - 4847::numeric / 9695))::integer <= 50 then
    raise exception 'the old expression would not have zeroed here — probe no longer discriminates';
  end if;
  raise notice 'discounted capture: new returns 25c, old delivered %c > 50c applied so it returned 0c',
    round(delivered_old::numeric * (1 - 4847::numeric / 9695))::integer;

  -- ═══ C. The case the old probe DID cover must not move ════════════════════
  -- Full capture, no discount: $200 gig, 765c credit, fee floored at 635c.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'full capture credit probe', 'Odd Jobs', 200, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  update public.bookings
     set fee_bps_quoted = 700, fee_credit_cents = 765, poster_discount_cents = 0
   where id = bid;
  -- pin_booking_amount ran consume_fee_credit on the INSERT above and may have attached
  -- one of this profile's real payable credits to the probe booking. Detach it, or
  -- return_unused_fee_credit would be summing someone's actual ledger (rolled back with
  -- everything else here).
  delete from public.bonus_ledger where applied_booking_id = bid;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values (bid, 'pi_full_credit_probe', 20000, 635, 19365, 0, 'captured', now(), true)
  returning id into pid;

  select public.fee_credit_delivered_cents(pid) into delivered_new;
  select greatest(0, public.platform_fee_cents(
           coalesce(amount_cents, 0) + coalesce(poster_discount_cents, 0),
           public.safe_fee_bps(fee_bps)) - coalesce(fee_cents, 0))
    into delivered_old from public.payments where id = pid;
  if delivered_new <> delivered_old or delivered_new <> 765 then
    raise exception 'regression: full undiscounted capture moved from %c to %c (want 765)',
      delivered_old, delivered_new;
  end if;
  raise notice 'full undiscounted capture is unchanged at 765c — only the two broken shapes move';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'delivered-credit probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
