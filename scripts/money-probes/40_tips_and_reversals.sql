-- Tips and reversals, on the real functions. Rolled back.
--
-- Asserts:
--   1. reserve_tip_slot is the CAP GATE and it is a WRITE, so concurrent tips cannot
--      both pass a lock-free read
--   2. an over-cap tip is refused
--   3. a released reservation stops consuming headroom, and keeps an addressable key
--   4. record_tip_reversal takes Stripe's CUMULATIVE total as a TARGET, so a webhook
--      redelivery is a no-op BY ARITHMETIC rather than by a separate idempotency check
--   5. record_refund is idempotent on refund_ledger.external_id, and debits the EARNER's
--      share only
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; pay_id uuid;
  k1 text; k2 text;
  r1 jsonb; r2 jsonb;
  ok boolean;
  earn0 numeric; earn1 numeric; earn2 numeric;
  rev1 int; rev2 int;
  led0 int; led1 int; led2 int;
  msg text := '';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Tip probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'verified', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at, captured_at)
  values (bid, 10000, 700, 9300, 'captured', 'pi_probe_tips', now(), now(), now())
  returning id into pay_id;

  -- 1 + 2. Reserve a sane tip, then an absurd one.
  select public.reserve_tip_slot(bid, 2000) into r1;
  msg := msg || format(E'\n  reserve 2000c -> %s', r1);
  select public.reserve_tip_slot(bid, 500000) into r2;
  msg := msg || format(E'\n  reserve 500000c (over cap) -> %s', r2);

  k1 := r1 ->> 'key';
  msg := msg || format(E'\n  tip_ledger rows now: %s (reserved)',
                       (select count(*) from public.tip_ledger where booking_id = bid));

  -- 3. Release it and confirm the headroom comes back.
  if k1 is not null then
    select public.release_tip_reservation(k1) into ok;
    msg := msg || format(E'\n  release_tip_reservation -> %s; rows still present: %s',
                         ok, (select count(*) from public.tip_ledger where booking_id = bid));
  end if;

  -- 4. A real tip, confirmed, then reversed TWICE with the same cumulative target.
  select public.reserve_tip_slot(bid, 2000) into r2;
  k2 := r2 ->> 'key';
  if k2 is not null then
    perform public.confirm_tip_charge(k2, 'pi_probe_tipcharge');
    select earnings_total into earn0 from public.profiles where id = earner;

    select public.record_tip_reversal('pi_probe_tipcharge', 2000, 'probe reversal') into rev1;
    select reversed_cents into rev2 from public.tip_ledger where payment_intent_id = 'pi_probe_tipcharge';
    select earnings_total into earn1 from public.profiles where id = earner;
    -- REDELIVERY: same cumulative target. Must move nothing.
    perform public.record_tip_reversal('pi_probe_tipcharge', 2000, 'probe reversal replay');
    select earnings_total into earn2 from public.profiles where id = earner;
    msg := msg || format(E'\n  tip reversal: reversed_cents=%s, earnings %s -> %s, after REPLAY -> %s',
                         rev2, earn0, earn1, earn2);
  end if;

  -- 5. record_refund twice with the SAME external id.
  select count(*) into led0 from public.refund_ledger;
  select earnings_total into earn0 from public.profiles where id = earner;
  perform public.record_refund(pay_id, 5000, 'probe refund', null, true, 're_probe_same');
  select count(*) into led1 from public.refund_ledger;
  select earnings_total into earn1 from public.profiles where id = earner;
  perform public.record_refund(pay_id, 5000, 'probe refund replay', null, true, 're_probe_same');
  select count(*) into led2 from public.refund_ledger;
  select earnings_total into earn2 from public.profiles where id = earner;
  msg := msg || format(E'\n  record_refund 5000c twice on external_id re_probe_same:'
                       || E'\n    refund_ledger rows %s -> %s -> %s (expect +1 then flat)'
                       || E'\n    earner earnings %s -> %s -> %s (expect one debit only)',
                       led0, led1, led2, earn0, earn1, earn2);
  msg := msg || format(E'\n    payments.refunded_cents=%s earner_refunded_cents=%s',
                       (select refunded_cents from public.payments where id = pay_id),
                       (select earner_refunded_cents from public.payments where id = pay_id));

  raise exception E'TIPS + REVERSALS PROBE (rolled back):%', msg;
end $$;
