-- ─────────────────────────────────────────────────────────────────────────────
-- A fee credit spent on a booking that is later refunded is destroyed.
--
-- release_booking_benefits is the only function that moves a bonus_ledger row from
-- 'applied' back to 'payable', and it early-returns the moment any payment for the
-- booking is captured (20260806260000:46-51). A refunded booking is captured BY
-- DEFINITION, so the restore at :78-84 is unreachable for every one of them. Its trigger
-- fires only on declined/cancelled, which a refunded booking never becomes.
--
-- record_refund writes refunded_cents, earner_refunded_cents and refund_ledger and calls
-- debit_earnings. It has never read bonus_ledger. So the earner pays for the refund twice:
-- once in the clawback, and again in a referral credit they earned, spent on this booking,
-- and cannot spend anywhere else.
--
-- 20260813130000 already solved the harder version of this for PARTIAL CAPTURES —
-- return_unused_fee_credit walks the applied rows newest-first, hands back
-- applied_total − delivered, splits the straddling row, and is idempotent on the delivered
-- figure. It is the right function; nothing called it from the refund path.
--
-- Reusing it rather than writing a second restore path is the point. A credit-return that
-- exists twice is a credit-return that disagrees with itself.
--
-- ── THE FIGURE ──────────────────────────────────────────────────────────────
-- delivered_now = delivered_at_capture × (1 − refunded/captured)
--
-- A full refund delivers nothing, so the whole applied credit comes back. A half refund
-- leaves half delivered. Because the RPC is idempotent on the DELIVERED figure and only
-- ever hands back the difference, calling it repeatedly with a shrinking number is safe —
-- which matters, since refunds arrive incrementally and record_refund is called once per
-- reversal.
--
-- Non-fatal by construction: the money has already moved at Stripe by the time
-- record_refund runs, and a bookkeeping failure must never roll back a refund that the
-- cardholder has already been given. ctl_credit_stranded_on_dead_booking and the hourly
-- sweep remain the backstop.
--
-- Found by the 2026-08-12 payments audit (incentives F11), reproduced 2026-08-14.
-- ─────────────────────────────────────────────────────────────────────────────

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
      -- What the credit was worth on this booking: the fee the earner would have paid
      -- without it, minus the fee they did pay. fee_credit_cents is what was DEBITED from
      -- the ledger, which is not the same number once the Stripe floor binds.
      select greatest(0,
               public.platform_fee_cents(
                 coalesce(amount_cents, 0) + coalesce(poster_discount_cents, 0),
                 public.safe_fee_bps(fee_bps))
             - coalesce(fee_cents, 0))
        into v_credit
        from public.payments where id = p_payment_id;

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

-- safe_fee_bps: the same guard stripe-create-payment-intent applies in TypeScript, so a
-- NULL or nonsense pinned rate cannot resolve to a free gig here either.
create or replace function public.safe_fee_bps(p_bps integer)
returns integer
language sql
immutable
set search_path = public
as $$ select case when p_bps is null or p_bps < 0 or p_bps > 3000 then 1000 else p_bps end $$;

-- ── Prove the credit comes back, and only in proportion ─────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid; promo uuid;
  applied_before int; payable_after int; payable_mid int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'credit refund probe', 'Odd Jobs', 200, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;

  -- $200 gig captured in full, with a 765c fee credit applied.
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited, fee_bps, fee_credit_cents)
  values (bid, 'pi_credit_refund_probe', 20000, 635, 19365, 0, 'captured', now(), true, 700, 765)
  returning id into pid;

  -- applied_booking_id, not booking_id: the ledger records the booking a credit was SPENT
  -- on separately from the one that earned it (source_booking_id).
  insert into public.bonus_ledger (user_id, reason, amount_cents, state, delivery, applied_booking_id, applied_at)
  values (uid, 'probe', 765, 'applied', 'credit', bid, now());
  select coalesce(sum(amount_cents), 0) into applied_before
    from public.bonus_ledger where applied_booking_id = bid and state = 'applied';
  if applied_before <> 765 then
    raise exception 'staging wrong: applied credit is %c', applied_before;
  end if;

  -- HALF refund → half the delivered value survives, so roughly half comes back.
  perform public.record_refund(pid, 10000, 'probe half refund', uid, true, 're_credit_probe_A');
  -- A returned credit DETACHES from the booking (applied_booking_id := null) — that is
  -- what "returned" means, so counting by booking here would always read zero and the
  -- probe would report failure on a working fix.
  select coalesce(sum(amount_cents), 0) into payable_mid
    from public.bonus_ledger where user_id = uid and reason = 'probe' and state = 'payable';
  if payable_mid <= 0 then
    raise exception 'FIX FAILED: a half refund returned none of the fee credit';
  end if;
  raise notice 'half refund returned %c of the applied 765c', payable_mid;

  -- The REST of it → nothing delivered, so the whole credit is back.
  perform public.record_refund(pid, 10000, 'probe rest', uid, true, 're_credit_probe_B');
  select coalesce(sum(amount_cents), 0) into payable_after
    from public.bonus_ledger where user_id = uid and reason = 'probe' and state = 'payable';
  if payable_after <= payable_mid then
    raise exception 'FIX FAILED: the second refund returned nothing more (% -> %)', payable_mid, payable_after;
  end if;
  raise notice 'full refund returns the whole credit: %c payable', payable_after;

  -- The OLD behaviour on this same row: release_booking_benefits early-returns on a
  -- captured payment, so nothing was ever restored.
  if exists (
    select 1 from public.payments p
     where p.id = pid and p.status = 'captured'
  ) then
    raise notice 'discriminates: release_booking_benefits early-returns on this captured payment, so the old path restored 0c';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'fee-credit refund probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
