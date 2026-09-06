-- ─────────────────────────────────────────────────────────────────────────────
-- Splitting a referral credit raises unique_violation on every REAL credit, so the
-- credit is silently never applied — and, one step later, never returned.
--
-- bonus_ledger carries a UNIQUE partial index (20260806070000:180-182):
--
--   bonus_ledger_dedupe on (user_id, reason, source_booking_id)
--     where source_booking_id is not null
--
-- and accrue_referral_bonus stamps every real referral bonus with
-- source_booking_id = new.id (20260806250000:71-76). So the accrual key is occupied.
--
-- The ORIGINAL consume_fee_credit knew this. Its split inserted the fragment with
-- source_booking_id = NULL (20260806080000:197-199, the literal `null` at the end of
-- the select list). The 20260814150000 rewrite — which added the kill-switch check and
-- had to reproduce the whole body to do it — quietly changed that one value to
-- `r2.source_booking_id`. The split INSERT now collides with the very row it just
-- shrank, and raises 23505.
--
-- return_unused_fee_credit (20260813130000:90-93, still the only definition) was
-- written against the rewritten shape and has the same defect: it shrinks the applied
-- row in place, which KEEPS that row's source_booking_id, and then inserts the payable
-- remainder carrying the same source_booking_id. Same key, same violation.
--
-- ── WHY NOBODY SAW IT ───────────────────────────────────────────────────────
--
-- Both migrations proved their own effect, and both probes staged the ledger row
-- WITHOUT a source_booking_id (20260814150000:224, 20260813130000:118). The partial
-- index does not cover NULLs, so the collision could not occur in either probe. The
-- split path was exercised; the index was not.
--
-- And every caller swallows it. pin_booking_amount wraps the consume call in
-- `exception when others then new.fee_credit_cents := 0; raise warning` — a PL/pgSQL
-- exception block is a subtransaction, so the whole credit application rolls back and
-- the booking pins a zero credit. stripe-capture-payment logs the RPC error and
-- carries on. record_refund wraps its return in `exception when others then raise
-- warning`, deliberately, so a bookkeeping failure cannot roll back a refund already
-- given. Three handlers, each correct in itself, one silent outcome.
--
-- ── HOW OFTEN THE SPLIT PATH RUNS: ordinarily ───────────────────────────────
--
-- The split fires whenever the credit exceeds the fee headroom (the fee minus the
-- Stripe floor). At the standing 700 bps that headroom is 150c on a $50 gig and 355c
-- on a $100 gig, so the console's $10 referral preset fits whole only on gigs of about
-- $257 and up. On an ordinary gig the split path IS the path.
--
-- ── THE FIX, AND THE RULE IT ESTABLISHES ────────────────────────────────────
--
-- A split does not mint a bonus; it divides one that already exists. Only one of the
-- two fragments may carry the accrual identity, and which one is not arbitrary:
-- vest_bonuses reaches a bonus for clawback through source_booking_id, and it only
-- ever touches `pending` and `payable` rows (`applied` rows are deliberately left to
-- return_unused_fee_credit, per its own comment). So:
--
--   THE PAYABLE SIDE OF A SPLIT KEEPS source_booking_id. THE APPLIED SIDE DOES NOT.
--
-- Under that rule the two functions land on different halves of the same statement:
--
--   consume_fee_credit  — the parent survives as the payable remainder and keeps its
--                         link; the newly inserted APPLIED fragment gets null. This is
--                         exactly the 20260806080000 shape, restored.
--   return_unused       — the parent survives as the APPLIED, delivered fragment, so
--                         the parent is the one that gives up the link; the newly
--                         inserted PAYABLE remainder keeps it. Nulling the applied row
--                         costs nothing — no function reads source_booking_id on an
--                         applied row — and nulling the payable one instead would have
--                         put the returned remainder permanently beyond clawback.
--
-- Both functions ALREADY drop source_user_id from the fragment (neither names it in
-- the insert), which is why bonus_ledger_one_per_referral never fired on this.
-- Dropping source_booking_id from the same fragment restores a consistency that was
-- only half there.
--
-- Found by the 2026-09-05 audit (money-db-pinning#1, money-db-incentives#1),
-- reproduced against the live definitions.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Body reproduced from 20260814150000 with one value changed ──────────────
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

  -- The incident lever, unchanged from 20260814150000. Scoped to the FLAG, not to
  -- campaign status: an already-earned credit survives its campaign merely ending.
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return 0;
  end if;

  -- Only what the credit can actually offset: the gap between the fee and the floor.
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
      -- Partially usable: spend what fits, leave the rest on the ledger. Splitting
      -- rather than forfeiting is the difference between a credit and a coupon.
      update public.bonus_ledger
         set amount_cents = amount_cents - (headroom - taken)
       where id = r.id;
      -- source_booking_id is NULL on the fragment, never copied. The parent row is the
      -- surviving PAYABLE remainder and keeps the accrual key; copying it here made the
      -- insert collide with that parent on bonus_ledger_dedupe, which aborted the whole
      -- credit application for every bonus a real accrual had stamped.
      insert into public.bonus_ledger
        (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id,
         applied_at, applied_booking_id)
      select r2.user_id, r2.promotion_id, r2.reason, headroom - taken, r2.delivery, 'applied',
             null, now(), p_booking
        from public.bonus_ledger r2 where r2.id = r.id;
      taken := headroom;
    end if;
  end loop;

  return taken;
end;
$$;

revoke execute on function public.consume_fee_credit(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_fee_credit(uuid, uuid, integer, integer) to service_role;

-- ── Body reproduced from 20260813130000 with the split branch corrected ─────
create or replace function public.return_unused_fee_credit(
  p_booking         uuid,
  p_delivered_cents integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  applied_total integer;
  unused        integer;
  given_back    integer := 0;
  r             record;
begin
  if p_booking is null then return 0; end if;

  select coalesce(sum(amount_cents), 0) into applied_total
    from public.bonus_ledger
   where applied_booking_id = p_booking and state = 'applied' and delivery = 'credit';

  if applied_total <= 0 then return 0; end if;

  unused := applied_total - greatest(0, coalesce(p_delivered_cents, 0));
  if unused <= 0 then return 0; end if;

  for r in
    select id, amount_cents, user_id, promotion_id, reason, delivery, source_booking_id
      from public.bonus_ledger
     where applied_booking_id = p_booking and state = 'applied' and delivery = 'credit'
     order by created_at desc
     for update
  loop
    exit when given_back >= unused;

    if r.amount_cents <= unused - given_back then
      -- Whole row goes back to payable and detaches from the booking.
      update public.bonus_ledger
         set state = 'payable', applied_at = null, applied_booking_id = null
       where id = r.id;
      given_back := given_back + r.amount_cents;
    else
      -- Straddles the boundary: shrink the applied row to what was actually delivered
      -- and mint a payable row for the remainder.
      --
      -- Here the PARENT stays applied, so the parent is the one that gives up the
      -- accrual key: two rows carrying the same (user_id, reason, source_booking_id)
      -- violate bonus_ledger_dedupe, and this insert aborted for every credit whose
      -- bonus was stamped by a real accrual. The payable remainder keeps the link,
      -- because payable is the state vest_bonuses can still claw back; nothing reads
      -- source_booking_id on an applied row.
      update public.bonus_ledger
         set amount_cents = amount_cents - (unused - given_back),
             source_booking_id = null
       where id = r.id;
      insert into public.bonus_ledger
        (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id)
      values (r.user_id, r.promotion_id, r.reason, unused - given_back, r.delivery,
              'payable', r.source_booking_id);
      given_back := unused;
    end if;
  end loop;

  return given_back;
end;
$$;

revoke execute on function public.return_unused_fee_credit(uuid, integer) from public, anon, authenticated;
grant execute on function public.return_unused_fee_credit(uuid, integer) to service_role;

-- ── Prove it, on a credit stamped the way a real accrual stamps one ─────────
do $$
declare
  uid uuid; src_job uuid; src_booking uuid;
  spend_job uuid; spend_booking uuid;
  ret_job uuid; ret_booking uuid;
  took int; back int;
  n_payable int; n_applied int; keeps uuid; frag uuid;
  collided boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A profile with no payable credit of its own, or consume_fee_credit would spend
  -- somebody's real bonus before it ever reached the staged one and the assertions
  -- below would be measuring the wrong row.
  select p.id into uid from public.profiles p
   where p.deleted_at is null
     and not exists (
       select 1 from public.bonus_ledger b
        where b.user_id = p.id and b.state = 'payable' and b.delivery = 'credit')
   limit 1;
  if uid is null then raise exception 'no live profile without a payable credit to stage against'; end if;

  -- The incident switch must be ON, or consume_fee_credit returns 0 for a reason that
  -- has nothing to do with this finding.
  insert into public.app_flags (key, enabled) values ('promotions_enabled', true)
  on conflict (key) do update set enabled = true;

  -- Three bookings: the one the bonus was EARNED on, the one the credit is SPENT on,
  -- and the one the return is exercised against. All created BEFORE any ledger row,
  -- because pin_booking_amount calls consume_fee_credit on booking INSERT.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'split probe source', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into src_job;
  insert into public.bookings (job_id, earner_id, status) values (src_job, uid, 'verified')
  returning id into src_booking;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'split probe spend', 'Odd Jobs', 50, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into spend_job;
  insert into public.bookings (job_id, earner_id, status) values (spend_job, uid, 'confirmed')
  returning id into spend_booking;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'split probe return', 'Odd Jobs', 200, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into ret_job;
  insert into public.bookings (job_id, earner_id, status) values (ret_job, uid, 'verified')
  returning id into ret_booking;

  -- ══ A. consume_fee_credit ════════════════════════════════════════════════
  --
  -- A vested credit stamped with a source booking, exactly as accrue_referral_bonus
  -- stamps one. 1000c against a $50 gig: headroom at 700 bps is 350 − 200 = 150c, so
  -- the credit straddles and the split branch runs. This is the ordinary case.
  insert into public.bonus_ledger
    (user_id, reason, amount_cents, delivery, state, source_booking_id, vests_at)
  values (uid, 'probe-consume', 1000, 'credit', 'payable', src_booking, now() - interval '8 days');

  -- THE DISCRIMINATION: the value the old body copied is the one the index rejects.
  collided := false;
  begin
    insert into public.bonus_ledger
      (user_id, reason, amount_cents, delivery, state, source_booking_id)
    values (uid, 'probe-consume', 150, 'credit', 'applied', src_booking);
  exception when unique_violation then
    collided := true;
  end;
  if not collided then
    raise exception 'probe is not discriminating: bonus_ledger_dedupe did not reject a '
                    'second row on the same (user, reason, source booking), so the old '
                    'split INSERT would have been harmless';
  end if;
  raise notice 'confirmed: a fragment carrying the parent''s source_booking_id is rejected by bonus_ledger_dedupe — that is exactly what the old body inserted';

  took := public.consume_fee_credit(uid, spend_booking, 5000, 700);
  if took <> 150 then
    raise exception 'FIX FAILED: split consume took %c, expected the 150c headroom '
                    '(0 means the unique_violation is still aborting it)', took;
  end if;

  select count(*), coalesce(sum(amount_cents), 0) into n_payable, took
    from public.bonus_ledger where user_id = uid and reason = 'probe-consume' and state = 'payable';
  if n_payable <> 1 or took <> 850 then
    raise exception 'FIX FAILED: payable remainder is % row(s) totalling %c, want 1 x 850c', n_payable, took;
  end if;
  select count(*), coalesce(sum(amount_cents), 0) into n_applied, took
    from public.bonus_ledger where user_id = uid and reason = 'probe-consume' and state = 'applied';
  if n_applied <> 1 or took <> 150 then
    raise exception 'FIX FAILED: applied fragment is % row(s) totalling %c, want 1 x 150c', n_applied, took;
  end if;
  raise notice 'the credit split 1000c -> 850c payable + 150c applied; nothing destroyed, nothing invented';

  -- And the accrual key sits on the payable side, where vest_bonuses can still reach it.
  select source_booking_id into keeps from public.bonus_ledger
   where user_id = uid and reason = 'probe-consume' and state = 'payable';
  select source_booking_id into frag from public.bonus_ledger
   where user_id = uid and reason = 'probe-consume' and state = 'applied';
  if keeps is distinct from src_booking then
    raise exception 'the payable remainder lost its source booking — vest_bonuses could no longer claw it back';
  end if;
  if frag is not null then
    raise exception 'the applied fragment still carries the accrual key, which IS the collision';
  end if;
  raise notice 'payable side keeps the accrual key, applied side does not — the rule that makes the split legal';

  -- ══ B. return_unused_fee_credit ══════════════════════════════════════════
  --
  -- 765c applied on a $200 gig (the 20260813130000 case) but only 355c delivered,
  -- because the poster settled a dispute at 50%. This time the applied row carries a
  -- source booking, which is the half that probe could not stage.
  insert into public.bonus_ledger
    (user_id, reason, amount_cents, delivery, state, source_booking_id, applied_at, applied_booking_id)
  values (uid, 'probe-return', 765, 'credit', 'applied', src_booking, now(), ret_booking);

  collided := false;
  begin
    insert into public.bonus_ledger
      (user_id, reason, amount_cents, delivery, state, source_booking_id)
    values (uid, 'probe-return', 410, 'credit', 'payable', src_booking);
  exception when unique_violation then
    collided := true;
  end;
  if not collided then
    raise exception 'probe is not discriminating on the return path either';
  end if;

  back := public.return_unused_fee_credit(ret_booking, 355);
  if back <> 410 then
    raise exception 'FIX FAILED: returned %c of the 410c that was consumed and never '
                    'delivered (0 means the unique_violation is still aborting it)', back;
  end if;

  select coalesce(sum(amount_cents), 0) into took
    from public.bonus_ledger where user_id = uid and reason = 'probe-return' and state = 'payable';
  if took <> 410 then
    raise exception 'FIX FAILED: payable after return is %c, want 410c', took;
  end if;
  select coalesce(sum(amount_cents), 0) into took
    from public.bonus_ledger
   where applied_booking_id = ret_booking and state = 'applied' and reason = 'probe-return';
  if took <> 355 then
    raise exception 'FIX FAILED: %c left applied, want the 355c that was actually delivered', took;
  end if;
  raise notice 'the undelivered 410c came back to payable and the delivered 355c stays spent';

  select source_booking_id into keeps from public.bonus_ledger
   where user_id = uid and reason = 'probe-return' and state = 'payable';
  if keeps is distinct from src_booking then
    raise exception 'the returned remainder lost its source booking — a later chargeback '
                    'on the source gig could no longer void it';
  end if;
  raise notice 'the returned remainder is payable AND still clawback-reachable, which nulling the new row instead would have cost';

  -- Idempotent on the delivered figure, as before.
  back := public.return_unused_fee_credit(ret_booking, 355);
  if back <> 0 then
    raise exception 'not idempotent: a second call with the same delivered figure returned %c', back;
  end if;
  raise notice 'idempotent on retry';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'split-collision probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
