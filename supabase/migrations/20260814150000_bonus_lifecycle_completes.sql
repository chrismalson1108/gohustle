-- ─────────────────────────────────────────────────────────────────────────────
-- Three holes in the referral bonus lifecycle, all in the same two functions.
--
-- 1. A BONUS IS NEVER CLAWED BACK ONCE IT VESTS. vest_bonuses voids only `pending` rows
--    whose source booking was reversed. The moment a row flips to `payable` it is beyond
--    reach: nothing anywhere else writes state='void'. So a referral that is reversed
--    AFTER the 7-day vesting window is money the platform still owes, on work that was
--    undone. Stripe's chargeback window is far longer than seven days, so this is not a
--    narrow race — it is the normal shape of a late dispute.
--
-- 2. VOIDING A BONUS NEVER RETURNS ITS CAMPAIGN BUDGET. The campaign is charged when the
--    bonus is MINTED (20260806250000:86-91 increments spent_cents and redemptions_used).
--    The void pass touches bonus_ledger only. release_booking_benefits — the one function
--    that returns budget — iterates promo_redemptions and knows nothing about
--    bonus_ledger. So a voided bonus permanently holds budget for a benefit that was
--    cancelled, and the campaign exhausts early against money it never gave away.
--
-- 3. THE INCIDENT KILL SWITCH DOES NOT REACH EITHER. `promotions_enabled` is checked by
--    consume_promo_grant and nowhere else. consume_fee_credit spends earned credits and
--    accrue_referral_bonus mints new ones, both without consulting it. A flag documented
--    as the incident lever that leaves two of the three incentive paths running is worse
--    than no flag: whoever flips it believes the bleeding stopped.
--
-- The distinction that shaped the fix: an ALREADY-EARNED credit should survive its
-- campaign merely ending — the user earned it, and CLAUDE.md is explicit that ending a
-- promotion never re-prices agreed work. But it must still be suspendable during an
-- incident. So consume_fee_credit gains the flag check and NOT a campaign-status check.
--
-- Found by the 2026-08-12 payments audit (incentives F12a, F12b, F13), reproduced
-- against current code 2026-08-14.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.vest_bonuses()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  -- Void PENDING rows whose source booking was reversed, and return the budget in the
  -- same statement. One statement so the two can never be applied separately: a void that
  -- committed without its refund would hold campaign budget forever, and a refund without
  -- its void would hand it back twice.
  with voided as (
    update public.bonus_ledger b
       set state = 'void',
           void_reason = 'source booking was reversed or disputed'
     where b.state = 'pending'
       and exists (
         select 1 from public.payments p
          where p.booking_id = b.source_booking_id
            and (coalesce(p.refunded_cents, 0) > 0 or p.status = 'refunded')
       )
    returning b.promotion_id, b.amount_cents
  ),
  by_promo as (
    select promotion_id, sum(amount_cents)::bigint as cents
      from voided where promotion_id is not null group by promotion_id
  )
  update public.promotions p
     set spent_cents      = greatest(0, p.spent_cents - bp.cents),
         redemptions_used = greatest(0, p.redemptions_used - 1)
    from by_promo bp
   where p.id = bp.promotion_id;

  -- ── And the same for a bonus that ALREADY VESTED ─────────────────────────
  --
  -- Previously unreachable: the void pass was scoped to 'pending', so a reversal landing
  -- after the vesting window left a payable bonus standing on undone work. A chargeback
  -- can arrive months later, so this is the ordinary case rather than a race.
  --
  -- Deliberately NOT applied to 'applied' rows: that credit has already been spent on a
  -- booking, and return_unused_fee_credit owns unwinding those. Two functions moving the
  -- same row between the same states is how a ledger starts disagreeing with itself.
  with voided_late as (
    update public.bonus_ledger b
       set state = 'void',
           void_reason = 'source booking was reversed after this bonus vested'
     where b.state = 'payable'
       and exists (
         select 1 from public.payments p
          where p.booking_id = b.source_booking_id
            and (coalesce(p.refunded_cents, 0) > 0 or p.status = 'refunded')
       )
    returning b.promotion_id, b.amount_cents
  ),
  late_by_promo as (
    select promotion_id, sum(amount_cents)::bigint as cents
      from voided_late where promotion_id is not null group by promotion_id
  )
  update public.promotions p
     set spent_cents      = greatest(0, p.spent_cents - lbp.cents),
         redemptions_used = greatest(0, p.redemptions_used - 1)
    from late_by_promo lbp
   where p.id = lbp.promotion_id;

  update public.bonus_ledger b
     set state = 'payable'
   where b.state = 'pending'
     and b.vests_at <= now()
     and not exists (
       select 1 from public.disputes d where d.booking_id = b.source_booking_id
         and coalesce(d.status, 'open') in ('open', 'investigating')
     );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── The kill switch reaches the credit-spending path ────────────────────────
create or replace function public.consume_fee_credit(
  p_user uuid, p_booking uuid, p_amount_cents integer, p_fee_bps integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  headroom integer;
  taken    integer := 0;
  r        record;
begin
  if p_user is null then return 0; end if;

  -- The incident lever. `promotions_enabled` was checked by consume_promo_grant alone, so
  -- flipping it left credit spending and bonus accrual running — and whoever flipped it
  -- believed the bleeding had stopped.
  --
  -- Scoped to the FLAG, not to campaign status: a credit the user has already earned must
  -- survive its campaign merely ending (CLAUDE.md: ending a promotion never re-prices
  -- agreed work). The switch suspends; it does not confiscate.
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return 0;
  end if;

  headroom := greatest(0,
      public.platform_fee_cents(p_amount_cents, p_fee_bps)
    - (ceil(coalesce(p_amount_cents, 0) * 0.029)::integer + 30 + 25));
  if headroom <= 0 then return 0; end if;

  for r in
    select id, amount_cents from public.bonus_ledger
     where user_id = p_user and state = 'payable' and delivery = 'credit'
     order by created_at asc
     for update
  loop
    exit when taken >= headroom;
    if r.amount_cents <= headroom - taken then
      update public.bonus_ledger
         set state = 'applied', applied_at = now(), applied_booking_id = p_booking
       where id = r.id;
      taken := taken + r.amount_cents;
    else
      update public.bonus_ledger
         set amount_cents = amount_cents - (headroom - taken)
       where id = r.id;
      insert into public.bonus_ledger
        (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id,
         applied_at, applied_booking_id)
      select r2.user_id, r2.promotion_id, r2.reason, headroom - taken, r2.delivery, 'applied',
             r2.source_booking_id, now(), p_booking
        from public.bonus_ledger r2 where r2.id = r.id;
      taken := headroom;
    end if;
  end loop;

  return taken;
end;
$$;

revoke execute on function public.consume_fee_credit(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_fee_credit(uuid, uuid, integer, integer) to service_role;

-- ── Prove all three ─────────────────────────────────────────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid; promo uuid;
  spent0 bigint; spent1 bigint; st text; took int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.promotions (name, kind, status, bonus_cents, budget_cents, max_redemptions)
  values ('probe referral', 'bonus', 'active', 500, 100000, 100) returning id into promo;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'bonus lifecycle probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values (bid, 'pi_bonus_lifecycle_probe', 10000, 700, 9300, 10000, 'captured', now(), true)
  returning id into pid;

  update public.promotions set spent_cents = 500, redemptions_used = 1 where id = promo;
  select spent_cents into spent0 from public.promotions where id = promo;

  -- (1) A bonus that ALREADY VESTED on a booking that was then refunded.
  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id, vests_at)
  values (uid, promo, 'probe', 500, 'credit', 'payable', bid, now() - interval '8 days');

  perform public.vest_bonuses();

  select state into st from public.bonus_ledger
   where source_booking_id = bid and reason = 'probe' limit 1;
  select spent_cents into spent1 from public.promotions where id = promo;

  if st <> 'void' then
    raise exception 'FIX FAILED: a vested bonus on a refunded booking is still %', st;
  end if;
  raise notice 'a bonus that vested before the reversal is now voided (was unreachable: the old pass only saw pending)';

  -- (2) And its budget came back.
  if spent1 >= spent0 then
    raise exception 'FIX FAILED: voiding returned no budget (% -> %)', spent0, spent1;
  end if;
  raise notice 'voiding returned the budget: spent %c -> %c', spent0, spent1;

  -- (3) The kill switch reaches credit spending.
  insert into public.bonus_ledger (user_id, promotion_id, reason, amount_cents, delivery, state)
  values (uid, promo, 'probe-spend', 500, 'credit', 'payable');

  took := public.consume_fee_credit(uid, bid, 20000, 700);
  if took <= 0 then
    raise exception 'probe is not discriminating: the credit could not be spent even with promotions ON';
  end if;

  update public.bonus_ledger set state = 'payable', applied_at = null, applied_booking_id = null
   where user_id = uid and reason = 'probe-spend';
  update public.app_flags set enabled = false where key = 'promotions_enabled';
  took := public.consume_fee_credit(uid, bid, 20000, 700);
  if took <> 0 then
    raise exception 'FIX FAILED: %c of credit was spent with promotions_enabled OFF', took;
  end if;
  raise notice 'the incident switch now suspends credit spending, which it never reached before';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'bonus lifecycle probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
