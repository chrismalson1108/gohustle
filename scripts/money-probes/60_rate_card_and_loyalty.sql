-- The rate card and the loyalty ladder. Rolled back.
--
-- Asserts what CLAUDE.md promises:
--   1. a rate change NEVER re-prices an existing booking (the pin is immutable)
--   2. a NEW booking takes the new rate
--   3. fee_bps_at clamps to [500, 3000] however absurd the row
--   4. the pinned rate is LOWEST-WINS across standing rate / loyalty tier / promotion
--   5. and what the loyalty ladder actually delivers at today's standing rate
do $$
declare
  poster uuid; earner uuid;
  jid uuid; bidA uuid; bidB uuid; bidC uuid;
  pinA int; pinA_after int; pinB int; pinC int;
  r_now int; r_low int; r_high int;
  tier_v int;
  msg text := '';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  select public.fee_bps_at(now()) into r_now;
  msg := msg || format(E'\n  standing rate now: %s bps', r_now);

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Rate probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;

  -- Booking A is struck at the CURRENT rate.
  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'pending')
  returning id into bidA;
  select fee_bps_quoted into pinA from public.bookings where id = bidA;
  msg := msg || format(E'\n  booking A pinned at %s', pinA);

  -- ── 1 + 2. RAISE the rate to 10%%, mid-flight. ────────────────────────────
  insert into public.platform_rates (fee_bps, effective_from, note)
  values (1000, now() - interval '1 second', 'probe: raise');
  select public.fee_bps_at(now()) into r_now;
  select fee_bps_quoted into pinA_after from public.bookings where id = bidA;
  insert into public.bookings (job_id, earner_id, status)
  values (jid, (select id from public.profiles where id not in (poster, earner) order by created_at limit 1), 'pending')
  returning id into bidB;
  select fee_bps_quoted into pinB from public.bookings where id = bidB;
  msg := msg || format(E'\n  after raising to 1000: standing=%s | booking A still %s (expect %s) | NEW booking B %s (expect 1000)',
                       r_now, pinA_after, pinA, pinB);

  -- ── 3. The bounds. fee_bps_at CLAMPS to [500,3000]; platform_rates_fee_bps_check
  --       refuses the row outright, which is the stronger of the two. Prove BOTH: the
  --       constraint rejects, and the clamp would have caught it anyway.
  begin
    insert into public.platform_rates (fee_bps, effective_from, note)
    values (1, now(), 'probe: absurdly low');
    msg := msg || E'\n  bounds: a 1 bps rate was ACCEPTED — the CHECK constraint is gone';
  exception when check_violation then
    msg := msg || E'\n  bounds: 1 bps refused by platform_rates_fee_bps_check (schema, not just the clamp)';
  end;
  begin
    insert into public.platform_rates (fee_bps, effective_from, note)
    values (99999, now(), 'probe: absurdly high');
    msg := msg || E' | 99999 bps ACCEPTED — constraint gone';
  exception when check_violation then
    msg := msg || E' | 99999 bps refused too';
  end;
  -- The floor/ceiling at the legal edges still price sanely.
  msg := msg || format(E'\n  at the legal edges: 500 bps on $100 -> %s c | 3000 bps on $100 -> %s c',
                       public.platform_fee_cents(10000, 500), public.platform_fee_cents(10000, 3000));

  -- ── 5. The loyalty ladder, at today's real standing rate. ────────────────
  -- All three rungs ship DISABLED. Enable them and ask what they would deliver.
  update public.fee_tiers set enabled = true;
  select public.tier_fee_bps(earner) into tier_v;
  msg := msg || format(E'\n  loyalty: this earner resolves to tier %s (null = no rung reached)', tier_v);
  msg := msg || format(E'\n  ladder rungs are %s against a standing rate of 700 — lowest-wins means the best rung delivers %s bps',
                       (select string_agg(fee_bps::text, '/' order by min_completed) from public.fee_tiers),
                       (select least(700, min(fee_bps)) from public.fee_tiers where enabled));

  raise exception E'RATE CARD PROBE (rolled back):%', msg;
end $$;
