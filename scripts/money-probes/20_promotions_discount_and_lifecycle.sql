-- Campaign LIFECYCLE and the poster_discount kind — the two things the /promotions
-- console writes that the fee_override probe did not reach. Rolled back.
--
-- Asserts:
--   1. poster_discount reduces what the POSTER is charged and leaves the earner's payout
--      untouched (it comes out of the platform's side, not the worker's)
--   2. the discount is clamped to the headroom above the processing floor, so the
--      platform's share can never go negative
--   3. the THREE ways a campaign ends all stop new grants: ends_at passing,
--      status='paused', and app_flags.promotions_enabled = false
--   4. ending a campaign NEVER re-prices work already agreed
--   5. estimate_campaign_cost prices against the LIVE standing rate, not a literal
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid;
  promo uuid; est jsonb;
  q_amt int; q_bps int; q_disc int; q_credit int;
  redeemed boolean;
  charged int; earner_net int; platform_keeps int;
  msg text := '';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  -- ── 5. The console's cost preview, against the live rate ─────────────────
  insert into public.promotions (name, kind, poster_discount_cents, uses_allowed, budget_cents,
                                 max_redemptions, status, starts_at, ends_at, max_benefit_cents)
  values ('probe poster discount', 'poster_discount', 300, 1, 10000, 20, 'active',
          now() - interval '1 day', now() + interval '30 days', 1000)
  returning id into promo;
  -- The console prices a campaign BEFORE it exists, so the signature takes the shape
  -- rather than an id: (kind, fee_bps, discount_cents, bonus_cents, uses, redemptions,
  -- typical_gig_cents). It must quote the LIVE standing rate, never a literal.
  select public.estimate_campaign_cost('poster_discount', 0, 300, 0, 1, 20, 5000) into est;
  msg := msg || format(E'\n  cost preview (300c discount x20 on a $50 gig): per_use=%s max_total=%s',
                       est ->> 'per_use_cents', est ->> 'max_total_cents');
  msg := msg || format(E'\n  preview note: %s', est ->> 'note');

  insert into public.promo_codes (promotion_id, code, max_redemptions)
  values (promo, 'PROBEDISCOUNT', 100);

  -- The POSTER redeems it (a discount is demand-side).
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',poster::text)::text, true);
  select public.redeem_promo_code('PROBEDISCOUNT') into redeemed;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  msg := msg || format(E'\n  poster redeemed the discount code: %s', redeemed);

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Discount probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'pending')
  returning id into bid;
  select amount_cents_quoted, fee_bps_quoted, poster_discount_cents, fee_credit_cents
    into q_amt, q_bps, q_disc, q_credit from public.bookings where id = bid;

  -- ── 1 + 2. Who pays what. Mirrors stripe-create-payment-intent exactly. ──
  charged        := greatest(50, q_amt - q_disc);
  earner_net     := q_amt - public.platform_fee_after_credit(q_amt, q_bps, q_credit);
  platform_keeps := public.platform_fee_after_credit(q_amt, q_bps, q_credit) - q_disc;
  msg := msg || format(E'\n  pins: amount=%s bps=%s discount=%s credit=%s', q_amt, q_bps, q_disc, q_credit);
  msg := msg || format(E'\n  poster charged %s | earner receives %s | platform keeps %s | reconciles: %s',
                       charged, earner_net, platform_keeps, charged = earner_net + platform_keeps);
  msg := msg || format(E'\n  headroom above the processing floor was %s, so a %s discount cannot make the platform share negative: %s',
                       public.poster_discount_headroom(q_amt, q_bps), q_disc, platform_keeps >= 0);

  -- ── 3. The three ways a campaign ends. ───────────────────────────────────
  -- (a) ends_at passes
  update public.promotions set ends_at = now() - interval '1 minute' where id = promo;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  select public.redeem_promo_code('PROBEDISCOUNT') into redeemed;
  msg := msg || format(E'\n  ended campaign (ends_at past) still grants: %s (expect false)', redeemed);
  -- (b) paused
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.promotions set ends_at = now() + interval '30 days', status = 'paused' where id = promo;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  select public.redeem_promo_code('PROBEDISCOUNT') into redeemed;
  msg := msg || format(E'\n  paused campaign still grants: %s (expect false)', redeemed);
  -- (c) the kill switch
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.promotions set status = 'active' where id = promo;
  update public.app_flags set enabled = false where key = 'promotions_enabled';
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  select public.redeem_promo_code('PROBEDISCOUNT') into redeemed;
  msg := msg || format(E'\n  promotions_enabled=false still grants: %s (expect false)', redeemed);

  -- ── 4. And the booking already struck keeps every pin. ───────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select amount_cents_quoted, fee_bps_quoted, poster_discount_cents
    into q_amt, q_bps, q_disc from public.bookings where id = bid;
  msg := msg || format(E'\n  after ALL THREE endings, the agreed booking still pins amount=%s bps=%s discount=%s',
                       q_amt, q_bps, q_disc);

  raise exception E'PROMO LIFECYCLE PROBE (rolled back):%', msg;
end $$;
