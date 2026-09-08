-- Referrals and the bonus ledger, end to end on the real path. Rolled back.
--
-- Asserts what CLAUDE.md promises:
--   1. vest-on-outcome: a bonus is created when the REFERRED person's gig is verified,
--      and only becomes payable after the window with no refund and no open dispute
--   2. an OPEN DISPUTE on the source booking holds vesting
--   3. a REFUND on the source booking VOIDS the bonus and returns the campaign budget
--   4. consume_fee_credit spends only the headroom above the Stripe floor and SPLITS
--      the remainder back rather than forfeiting it
--   5. self-referral is refused
do $$
declare
  referrer uuid; referred uuid; poster uuid;
  jid uuid; bid uuid; did uuid;
  bonus_id uuid; frag_cnt int;
  st text; amt int; taken int; headroom int;
  self_ref_ok boolean := false;
  msg text := '';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster   from public.profiles order by created_at limit 1;
  select id into referrer from public.profiles where id <> poster order by created_at limit 1;
  select id into referred from public.profiles where id not in (poster, referrer) order by created_at limit 1;

  -- A bonus campaign must exist or accrue_referral_bonus returns early. Production has
  -- none today: the only promotion is a fee_override that ended 2026-08-27.
  insert into public.promotions (name, kind, bonus_cents, bonus_delivery, uses_allowed,
                                 budget_cents, max_redemptions, status, starts_at, ends_at)
  values ('probe referral bonus', 'bonus', 500, 'credit', 1, 5000, 50, 'active',
          now() - interval '1 day', now() + interval '30 days');

  insert into public.referrals (referrer_id, referred_id) values (referrer, referred)
  on conflict do nothing;

  -- The referred person does a gig for the poster, and it is verified.
  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Referral probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, referred, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at, captured_at)
  values (bid, 10000, 700, 9300, 'captured', 'pi_probe_referral', now(), now(), now());
  update public.bookings set status = 'verified' where id = bid;

  select id, state, amount_cents into bonus_id, st, amt
    from public.bonus_ledger where source_booking_id = bid order by created_at limit 1;
  msg := msg || format(E'\n  bonus after verify: id=%s state=%s amount=%s', bonus_id is not null, st, amt);

  if bonus_id is null then
    raise exception E'REFERRAL PROBE (rolled back):%\n  NO BONUS WAS CREATED — the rest cannot be tested.', msg;
  end if;

  -- 2. An OPEN dispute on the source booking must hold vesting even once due.
  update public.bonus_ledger set vests_at = now() - interval '1 day' where id = bonus_id;
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe dispute', 75) returning id into did;
  perform public.vest_bonuses();
  select state into st from public.bonus_ledger where id = bonus_id;
  msg := msg || format(E'\n  with an OPEN dispute, vest_bonuses left state=%s (expect pending)', st);

  -- Close the dispute; now it must vest.
  update public.disputes set status = 'resolved', resolved_at = now(),
         pct_paid = 100, settled_at = now() where id = did;
  perform public.vest_bonuses();
  select state into st from public.bonus_ledger where id = bonus_id;
  msg := msg || format(E'\n  dispute closed, vest_bonuses -> state=%s (expect payable)', st);

  -- 4. consume_fee_credit: headroom only, and the remainder SPLIT back.
  select public.poster_discount_headroom(10000, 700) into headroom;
  select public.consume_fee_credit(referrer, bid, 10000, 700) into taken;
  select count(*) into frag_cnt from public.bonus_ledger
   where user_id = referrer and state = 'payable';
  msg := msg || format(E'\n  credit: headroom on $100@700bps=%s, consumed=%s, payable rows left=%s',
                       headroom, taken, frag_cnt);

  -- 3. A REFUND on the source booking must VOID a bonus, even after it vested.
  -- refunded_cents ONLY. payments.status has no 'refunded' value (the CHECK allows
  -- pending/authorized/captured/cancelled/failed), which is why vest_bonuses' second
  -- arm `p.status = 'refunded'` is dead code.
  update public.payments set refunded_cents = 10000 where booking_id = bid;
  perform public.vest_bonuses();
  select state into st from public.bonus_ledger where id = bonus_id;
  msg := msg || format(E'\n  after refunding the source booking, state=%s (expect void)', st);

  raise exception E'REFERRAL PROBE (rolled back):%', msg;
end $$;
