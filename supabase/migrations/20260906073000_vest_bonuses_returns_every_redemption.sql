-- ─────────────────────────────────────────────────────────────────────────────
-- vest_bonuses returns every voided bonus's MONEY but only ever one SEAT.
--
-- Both void passes in 20260814150000 aggregate the rows they voided per promotion
-- (`sum(amount_cents)`) and then write:
--
--     set spent_cents      = greatest(0, p.spent_cents - bp.cents),
--         redemptions_used = greatest(0, p.redemptions_used - 1)
--
-- The UPDATE ... FROM joins ONE aggregate row per promotion, so the literal 1 is applied
-- once no matter how many bonuses were voided. The charge side is per bonus:
-- accrue_referral_bonus (20260806250000:86-90) increments redemptions_used by 1 for each
-- row it mints. So N bonuses voided on one campaign in one sweep return N × bonus_cents
-- of budget and exactly ONE use, leaving N−1 seats burned for the life of the campaign.
--
-- Why that costs something real: max_redemptions is a hard ceiling, enforced as part of
-- the same increment that charges the campaign (`and redemptions_used < max_redemptions`).
-- A campaign capped at 100 that voids two bonuses in one hourly sweep will refuse its
-- 100th genuine referral while its budget still has the money for it — and the refusal is
-- silent, because accrue_referral_bonus withdraws the minted row and returns without
-- raising. The referrer simply never gets the bonus they earned.
--
-- Two bonuses voiding in one sweep is not a contrived case. The pass voids every pending
-- or payable bonus whose source booking has been reversed, and the sweep runs hourly, so
-- any campaign with more than one reversal inside the same hour hits it — a refund run by
-- support, or a batch of chargebacks, produces exactly that.
--
-- THE FIX: aggregate `count(*)` alongside the cents and subtract it. Nothing else in
-- either pass changes. count(*) is exact here rather than approximate — a row is voided
-- only when a payments row exists for its source_booking_id, so every voided row carries
-- a non-null source_booking_id and is a MINTING row, which is one-per-charge by
-- construction (bonus_ledger_dedupe is unique on (user_id, reason, source_booking_id)
-- where source_booking_id is not null). That is the same population
-- ctl_redemption_double_charge counts on the other side of the reconciliation.
--
-- This drift is what 20260906035000 predicted it would newly make visible once the
-- double-charge control started reading bonus_ledger for bonus campaigns; that migration
-- deliberately left the decrement alone so the fix could carry its own proof. This is it.
--
-- Found by the money-db-pinning audit (money-db-pinning#5, also money-db-incentives#3),
-- reproduced against current code 2026-09-06.
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
    -- BOTH sides of the charge, per promotion. The seat count used to be a literal 1 in
    -- the UPDATE below, which returned every voided bonus's money and exactly one
    -- campaign use however many rows the statement voided.
    select promotion_id, sum(amount_cents)::bigint as cents, count(*)::bigint as uses
      from voided where promotion_id is not null group by promotion_id
  )
  update public.promotions p
     set spent_cents      = greatest(0, p.spent_cents - bp.cents),
         redemptions_used = greatest(0, p.redemptions_used - bp.uses)
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
    select promotion_id, sum(amount_cents)::bigint as cents, count(*)::bigint as uses
      from voided_late where promotion_id is not null group by promotion_id
  )
  update public.promotions p
     set spent_cents      = greatest(0, p.spent_cents - lbp.cents),
         redemptions_used = greatest(0, p.redemptions_used - lbp.uses)
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

revoke execute on function public.vest_bonuses() from public, anon, authenticated;
grant  execute on function public.vest_bonuses() to service_role;


-- ── Prove it: two bonuses voided in one sweep return two seats ──────────────
-- Staged, asserted, rolled back. The discrimination is explicit: the probe measures how
-- many rows each pass actually voided, so a constant-1 decrement is provably wrong on
-- this data before the new decrement is checked against it.
do $$
declare
  uid uuid;
  promo uuid;
  jid_a uuid; jid_b uuid; bid_a uuid; bid_b uuid;
  jid_c uuid; jid_d uuid; bid_c uuid; bid_d uuid;
  used0 int; used1 int; spent0 bigint; spent1 bigint;
  voided_rows int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.promotions (name, kind, status, bonus_cents, budget_cents, max_redemptions)
  values ('probe vest seat return', 'bonus', 'active', 500, 100000, 100) returning id into promo;

  -- Four reversed source bookings: two for the pending pass, two for the payable pass.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'vest seat probe A', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_a;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'vest seat probe B', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_b;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'vest seat probe C', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_c;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'vest seat probe D', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_d;

  insert into public.bookings (job_id, earner_id, status) values (jid_a, uid, 'verified') returning id into bid_a;
  insert into public.bookings (job_id, earner_id, status) values (jid_b, uid, 'verified') returning id into bid_b;
  insert into public.bookings (job_id, earner_id, status) values (jid_c, uid, 'verified') returning id into bid_c;
  insert into public.bookings (job_id, earner_id, status) values (jid_d, uid, 'verified') returning id into bid_d;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited)
  values
    (bid_a, 'pi_vest_seat_probe_a', 10000, 700, 9300, 10000, 'captured', now(), true),
    (bid_b, 'pi_vest_seat_probe_b', 10000, 700, 9300, 10000, 'captured', now(), true),
    (bid_c, 'pi_vest_seat_probe_c', 10000, 700, 9300, 10000, 'captured', now(), true),
    (bid_d, 'pi_vest_seat_probe_d', 10000, 700, 9300, 10000, 'captured', now(), true);

  -- ── Pass 1: two PENDING bonuses on one campaign, both reversed ───────────
  -- The campaign was charged once per minted bonus, so it stands at 2 uses / 1000c.
  update public.promotions set redemptions_used = 2, spent_cents = 1000 where id = promo;
  select redemptions_used, spent_cents into used0, spent0 from public.promotions where id = promo;

  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id, vests_at)
  values
    (uid, promo, 'probe_seat_a', 500, 'credit', 'pending', bid_a, now() + interval '7 days'),
    (uid, promo, 'probe_seat_b', 500, 'credit', 'pending', bid_b, now() + interval '7 days');

  perform public.vest_bonuses();

  select count(*) into voided_rows from public.bonus_ledger
   where promotion_id = promo and state = 'void' and source_booking_id in (bid_a, bid_b);
  if voided_rows <> 2 then
    raise exception 'staging wrong: the pending pass voided % row(s), so this proves nothing', voided_rows;
  end if;
  -- THE DISCRIMINATION. Two rows were voided in one statement; the old body subtracted a
  -- literal 1 from redemptions_used regardless, and would leave used0 - 1 = 1 here.
  raise notice 'pending pass voided % bonuses in one statement — the old body returned exactly 1 seat for them', voided_rows;

  select redemptions_used, spent_cents into used1, spent1 from public.promotions where id = promo;
  if spent1 <> spent0 - 1000 then
    raise exception 'staging wrong: budget returned %c, expected 1000c', spent0 - spent1;
  end if;
  if used1 <> used0 - voided_rows then
    raise exception 'FIX FAILED: % bonuses voided returned % seat(s) (redemptions_used % -> %)',
      voided_rows, used0 - used1, used0, used1;
  end if;
  raise notice 'pending pass: redemptions_used % -> %, one seat per voided bonus', used0, used1;

  -- ── Pass 2: the same for the PAYABLE (late-reversal) pass ────────────────
  update public.promotions set redemptions_used = 2, spent_cents = 1000 where id = promo;
  select redemptions_used, spent_cents into used0, spent0 from public.promotions where id = promo;

  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id, vests_at)
  values
    (uid, promo, 'probe_seat_c', 500, 'credit', 'payable', bid_c, now() - interval '8 days'),
    (uid, promo, 'probe_seat_d', 500, 'credit', 'payable', bid_d, now() - interval '8 days');

  perform public.vest_bonuses();

  select count(*) into voided_rows from public.bonus_ledger
   where promotion_id = promo and state = 'void' and source_booking_id in (bid_c, bid_d);
  if voided_rows <> 2 then
    raise exception 'staging wrong: the payable pass voided % row(s), so this proves nothing', voided_rows;
  end if;

  select redemptions_used, spent_cents into used1, spent1 from public.promotions where id = promo;
  if spent1 <> spent0 - 1000 then
    raise exception 'staging wrong: budget returned %c, expected 1000c', spent0 - spent1;
  end if;
  if used1 <> used0 - voided_rows then
    raise exception 'FIX FAILED (late pass): % bonuses voided returned % seat(s) (redemptions_used % -> %)',
      voided_rows, used0 - used1, used0, used1;
  end if;
  raise notice 'payable pass: redemptions_used % -> %, one seat per voided bonus', used0, used1;

  -- ── And the reconciliation control now agrees with the campaign ──────────
  -- Every bonus on this campaign is void and every seat came back, so the counter and
  -- the ledger match. Under the old decrement this campaign sat at 1 use against 0 live
  -- rows, which ctl_redemption_double_charge reports as a CRITICAL money finding that
  -- can never auto-resolve.
  if exists (select 1 from public.ctl_redemption_double_charge() where entity_id = promo::text) then
    raise exception 'FIX FAILED: the double-charge control still reports this fully-unwound campaign';
  end if;
  raise notice 'ctl_redemption_double_charge is silent on the unwound campaign — the seat drift is gone at the source';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'vest_bonuses seat-return probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
