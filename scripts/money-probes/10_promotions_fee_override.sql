-- The promotion chain, end to end, on the REAL path: redeem a code, then book, and let
-- pin_booking_amount consume the grant. Rolled back.
--
-- Asserts what CLAUDE.md promises: lowest-wins pinning, budget exhaustion as the
-- increment itself, one grant per user per promotion, an exhausted budget still letting
-- the booking through at the standing rate, and redeem_promo_code not being an oracle.
do $$
declare
  poster uuid; earner uuid; promo uuid; jid uuid; bid uuid; bid2 uuid; jid2 uuid;
  bad_code boolean; good_code boolean; second_redeem boolean;
  spent0 int; spent1 int; used0 int; used1 int;
  q_bps int; q_amt int; q_credit int; q_disc int;
  q2_bps int;
  msg text := '';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  insert into public.promotions (name, kind, fee_bps, uses_allowed, budget_cents,
                                 max_redemptions, status, starts_at, ends_at, max_benefit_cents)
  values ('probe campaign', 'fee_override', 0, 5, 400, 5, 'active',
          now() - interval '1 day', now() + interval '30 days', 100000)
  returning id into promo;
  insert into public.promo_codes (promotion_id, code, max_redemptions)
  values (promo, 'PROBEONLY2026', 100);

  -- Oracle check + one-grant-per-user, as the EARNER (a fee_override is supply-side).
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  select public.redeem_promo_code('DEFINITELYNOTACODE') into bad_code;
  select public.redeem_promo_code('PROBEONLY2026')      into good_code;
  begin
    select public.redeem_promo_code('PROBEONLY2026') into second_redeem;
  exception when unique_violation then second_redeem := null;
  end;
  msg := msg || format(E'\n  redeem: junk=%s real=%s second=%s (null = raised unique_violation)',
                       bad_code, good_code, second_redeem);

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select spent_cents, redemptions_used into spent0, used0 from public.promotions where id = promo;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Promo probe A', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'pending')
  returning id into bid;

  select fee_bps_quoted, amount_cents_quoted, fee_credit_cents, poster_discount_cents
    into q_bps, q_amt, q_credit, q_disc
    from public.bookings where id = bid;
  select spent_cents, redemptions_used into spent1, used1 from public.promotions where id = promo;

  msg := msg || format(E'\n  booking A pins: amount=%s fee_bps=%s credit=%s discount=%s',
                       q_amt, q_bps, q_credit, q_disc);
  msg := msg || format(E'\n  campaign after A: spent %s -> %s (budget 400), redemptions %s -> %s',
                       spent0, spent1, used0, used1);

  -- A SECOND booking by the same earner. The budget is now at/over its cap, so the grant
  -- must NOT apply — and the booking must still succeed, at the standing rate.
  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Promo probe B', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, earner, 'pending')
  returning id into bid2;
  select fee_bps_quoted into q2_bps from public.bookings where id = bid2;

  msg := msg || format(E'\n  booking B fee_bps=%s (standing rate is %s) — booking succeeded: %s',
                       q2_bps, public.fee_bps_at(now()), bid2 is not null);

  raise exception E'PROMO CHAIN PROBE (rolled back):%', msg;
end $$;
