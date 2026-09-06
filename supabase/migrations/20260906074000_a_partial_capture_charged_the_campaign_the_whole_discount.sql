-- ─────────────────────────────────────────────────────────────────────────────
-- A campaign is charged the WHOLE poster discount on a capture that only delivered
-- half of it.
--
-- settle_booking_benefits takes p_amount_cents — the gig value this settlement actually
-- landed at — and the poster_discount branch never looks at it
-- (20260813140000_settle_benefits_at_booking_rate.sql:89-96). It reads
-- payments.poster_discount_cents, the FULL pinned discount, and calls that the delivered
-- figure.
--
-- The caller already knows better. stripe-capture-payment's partial branch scales the
-- discount precisely because it does not survive a partial capture whole
-- (supabase/functions/stripe-capture-payment/index.ts:335-352):
--
--     captureCents     = round(amount_cents * pct)          -- pct of the DISCOUNTED hold
--     capturedGigCents = captureCents + round(discount * pct)
--
-- and its comment spells out why: "captureCents is a percentage of the already-discounted
-- authorization, so the poster only received `pct` of the discount". That scaled figure
-- is handed to settle_booking_benefits as p_amount_cents — and then discarded.
--
-- ── THE ARITHMETIC ──────────────────────────────────────────────────────────
-- $100 gig at 700 bps. poster_discount_headroom(10000, 700) = 700 − 345 = 355, so the
-- campaign gives 355c and the hold is 9645c. The poster reports a problem and settles at
-- 50%: Stripe collects 4823c, so the poster paid 4823c on work worth 5001c and received
-- 178c of discount — not 355c.
--
--   today:  actual = 355  ⇒  delta = 355 − 355 = 0    ⇒ spent_cents stays at 355
--   truth:  actual = 178  ⇒  delta = 178 − 355 = −177 ⇒ spent_cents relaxes to 178
--
-- The campaign is charged (1 − pct) × discount for benefit nobody got. A $50 budget is
-- exhausted after ~14 such gigs having delivered ~$25, and the /promotions burn-down bar
-- reports the campaign as spent when half of it is still unspent. It is the exact mirror
-- of the 20260813040000 defect — that one under-charged campaigns, this one over-charges
-- them — and the control written for that one, ctl_promo_spend_understated, only tests
-- `delivered > spent`, so it is blind in this direction by construction.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Scale the pinned discount by the share of the gig this settlement actually collected:
--
--     delivered = round(discount × p_amount_cents / (amount_cents + discount))
--
-- Both denominators are the pinned, immutable inputs capture itself derives from —
-- amount_cents is never rewritten and poster_discount_cents is pinned by
-- trg_z_pin_payment_fee_bps — so this stays idempotent under a capture retry, which is
-- the property the whole settle path rests on. On a FULL capture p_amount_cents is the
-- whole gig value, the ratio is 1, and the number is unchanged from today's — which is
-- why earner-claim-payment and admin-payment-action's settle op, both of which always
-- capture the full hold, are unaffected.
--
-- Clamped to the pinned discount: a reconciliation that hands back slightly more than
-- was authorized must never let a campaign be charged more than it ever offered.
--
-- The fee_override branch and the booking-time counterfactual from 20260813140000 are
-- carried through untouched.
--
-- ── AND A CONTROL, because the invariant belongs against data ───────────────
-- ctl_discount_settled_above_delivered re-derives the delivered discount from the LEDGER
-- (earner_amount_cents + fee_cents against the authorized amount_cents, the same way
-- stripe-capture-payment's recovery block re-derives it) and reports any settled
-- redemption charged more than that. It fires on every row the old code already settled,
-- which is the point: those campaigns are over-charged today and nothing says so.
--
-- Found by the 2026-09-05 audit (money-db-pinning#6).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.settle_booking_benefits(p_booking uuid, p_amount_cents integer)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  r         public.promo_redemptions%rowtype;
  k         text;
  cap       int;
  actual    int;
  delta     int;
  n         int := 0;
  booked_at timestamptz;
  pay_auth  int;
  pay_disc  int;
  gig_total int;
begin
  if p_booking is null or p_amount_cents is null then return 0; end if;

  -- The moment the deal was struck. Every benefit is priced against the world as it was
  -- then, for the same reason bookings.fee_bps_quoted is pinned at INSERT.
  select created_at into booked_at from public.bookings where id = p_booking;
  booked_at := coalesce(booked_at, now());

  for r in
    select * from public.promo_redemptions
     where booking_id = p_booking
       and released_at is null
       and settled_at is null
     for update
  loop
    select kind, max_benefit_cents into k, cap
      from public.promotions where id = r.promotion_id;

    if k = 'poster_discount' then
      -- The cost IS the discount — but only the part of it the poster ACTUALLY
      -- RECEIVED. Both columns are pinned at booking and cannot drift, so every
      -- figure below survives a capture retry unchanged.
      select coalesce(amount_cents, 0), coalesce(poster_discount_cents, 0)
        into pay_auth, pay_disc
        from public.payments
       where booking_id = p_booking and coalesce(poster_discount_cents, 0) > 0
       order by created_at desc limit 1;

      if coalesce(pay_disc, 0) = 0 then
        -- No payment row to read; the reserve is all we know.
        actual := r.reserved_cents;
      else
        -- The FULL gig value: what the poster would have paid without the campaign.
        -- p_amount_cents is what this settlement landed at, scaled the same way by the
        -- caller (captured + round(discount × pct)), so the ratio is the delivered share.
        gig_total := pay_auth + pay_disc;
        if gig_total <= 0 then
          actual := pay_disc;
        else
          actual := greatest(0, least(
            pay_disc,
            round(pay_disc::numeric * least(p_amount_cents, gig_total) / gig_total)::int));
        end if;
      end if;
    else
      -- fee_override. Priced at the BOOKING's rate, not today's — 20260813140000.
      actual := public.promo_benefit_cents(p_amount_cents, r.fee_bps, booked_at);
    end if;

    -- The campaign's per-use ceiling still applies to what it is CHARGED.
    actual := least(coalesce(cap, r.reserved_cents), actual);

    delta := actual - r.reserved_cents;

    -- Only ever RELAX the budget here (delta is normally negative — the reserve was the
    -- worst case). A positive delta is possible if the campaign's own ceiling exceeds the
    -- reserve; allow it, because the money genuinely was spent, but the ceiling bounds it.
    update public.promotions
       set spent_cents = greatest(0, spent_cents + delta)
     where id = r.promotion_id;

    update public.promo_redemptions
       set benefit_cents = actual, settled = true, settled_at = now()
     where id = r.id;

    n := n + 1;
  end loop;

  return n;
end;
$function$;

revoke execute on function public.settle_booking_benefits(uuid, integer) from public, anon, authenticated;
grant execute on function public.settle_booking_benefits(uuid, integer) to service_role;

-- ── Control ─────────────────────────────────────────────────────────────────
-- The invariant asserted against DATA, not against the formula: a settled
-- poster-discount redemption may not be charged more than the capture delivered.
create or replace function public.ctl_discount_settled_above_delivered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.booking_id::text,
         jsonb_build_object(
           'kind', 'settled_above_delivered',
           'promotion_id', r.promotion_id,
           'charged_cents', r.benefit_cents,
           'delivered_cents', d.delivered,
           'pinned_discount_cents', d.disc,
           'authorized_cents', d.auth_cents,
           'collected_cents', d.collected,
           'note', 'this campaign was charged the whole pinned poster discount on a '
                   'capture that only collected part of the hold, so it paid for benefit '
                   'the poster never received. The delivered figure is re-derived from '
                   'the ledger (earner_amount_cents + fee_cents against the authorized '
                   'amount_cents), the same way stripe-capture-payment re-derives it.',
           'remedy', 'Relax promotions.spent_cents by (charged - delivered) for this '
                     'redemption and set promo_redemptions.benefit_cents to the '
                     'delivered figure. If this is firing on NEW captures, '
                     'settle_booking_benefits has lost the scaling again.'
         )
    from public.promo_redemptions r
    join public.promotions p on p.id = r.promotion_id
    join lateral (
      select coalesce(pay.amount_cents, 0) auth_cents,
             coalesce(pay.poster_discount_cents, 0) disc,
             coalesce(pay.earner_amount_cents, 0) + coalesce(pay.fee_cents, 0) collected,
             round(coalesce(pay.poster_discount_cents, 0)::numeric
                   * least(1, (coalesce(pay.earner_amount_cents, 0) + coalesce(pay.fee_cents, 0))::numeric
                              / nullif(pay.amount_cents, 0)))::int delivered
        from public.payments pay
       where pay.booking_id = r.booking_id
         and pay.status = 'captured'
         and coalesce(pay.poster_discount_cents, 0) > 0
       order by pay.created_at desc limit 1
    ) d on true
   where p.kind = 'poster_discount'
     and r.settled
     and r.released_at is null
     -- 1c of slack: the caller scales the discount once and this scales it again, so
     -- the two roundings can legitimately disagree by a cent.
     and r.benefit_cents > d.delivered + 1
$$;

revoke execute on function public.ctl_discount_settled_above_delivered() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('discount_settled_above_delivered',
   'A poster-discount campaign was charged more than a partial capture delivered',
   'medium', 'money',
   'settle_booking_benefits priced a poster discount at the FULL pinned amount and '
   'ignored the scaled gig value its caller passes, so a capture settled at 50% charged '
   'the campaign 100% of the discount. Budgets exhaust against benefit nobody received '
   'and the burn-down bar reads spent while half the money is unspent. '
   'ctl_promo_spend_understated tests only delivered > spent, so it is blind in this '
   'direction; this asserts the other side, against the ledger rather than the formula.',
   'ctl_discount_settled_above_delivered')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Prove the campaign is charged what it delivered, and no more ────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid; promo uuid; grant_id uuid;
  spent_before int; spent_after int; benefit int; n_ctl int;
  bid2 uuid; benefit2 int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.promotions
    (name, kind, status, poster_discount_cents, budget_cents, max_redemptions,
     max_benefit_cents, spent_cents)
  values ('partial capture discount probe', 'poster_discount', 'active', 355, 50000, 100,
          15000, 355)
  returning id into promo;

  -- EXHAUSTED on purpose. consume_poster_discount picks grants with
  -- uses_consumed < uses_allowed, so this one cannot fire on the booking INSERT below
  -- and mint a redemption of its own — the probe stages that row itself, with the exact
  -- reserve the arithmetic in the header depends on.
  insert into public.promo_grants (user_id, promotion_id, uses_allowed, uses_consumed)
  values (uid, promo, 1, 1) returning id into grant_id;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'partial capture discount probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;

  -- ── The $100 gig from the header, settled at 50% ──────────────────────────
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  -- Stage the pin explicitly. pin_booking_amount permits this only under service_role
  -- claims, which is exactly the exemption the capture path itself runs under.
  update public.bookings
     set amount_cents_quoted = 10000, fee_bps_quoted = 700,
         fee_credit_cents = 0, poster_discount_cents = 355
   where id = bid;

  -- Stripe collected 4823c of the 9645c hold: fee 195 (re-floored at the processing
  -- cost of the captured amount) + earner 4628.
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     status, captured_at, earnings_credited)
  values (bid, 'pi_partial_discount_probe', 9645, 195, 4628, 'captured', now(), true)
  returning id into pid;
  if (select poster_discount_cents from public.payments where id = pid) <> 355 then
    raise exception 'staging wrong: the payment did not inherit the 355c pin';
  end if;

  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (grant_id, promo, uid, bid, 700, 355);

  select spent_cents into spent_before from public.promotions where id = promo;

  -- capturedGigCents = 4823 + round(355 x 0.5) = 5001, exactly what
  -- stripe-capture-payment passes on this capture.
  perform public.settle_booking_benefits(bid, 5001);

  select benefit_cents into benefit from public.promo_redemptions where booking_id = bid;
  select spent_cents into spent_after from public.promotions where id = promo;

  -- THE DISCRIMINATION: the old body read payments.poster_discount_cents straight and
  -- settled at 355, leaving spent_cents at 355 and delta at 0.
  if benefit = 355 then
    raise exception 'FIX FAILED: the campaign was still charged the whole 355c discount on a half capture';
  end if;
  if benefit <> 178 then
    raise exception 'FIX FAILED: delivered discount settled at %c, expected 178c', benefit;
  end if;
  if spent_after <> spent_before - 177 then
    raise exception 'FIX FAILED: spent_cents went % -> %, expected a 177c relaxation',
      spent_before, spent_after;
  end if;
  raise notice 'a half capture charges the campaign %c of the 355c discount and relaxes spend % -> % — the old body charged 355c and relaxed nothing',
    benefit, spent_before, spent_after;

  -- The control agrees with the fix: nothing to report on the correctly settled row.
  select count(*) into n_ctl from public.ctl_discount_settled_above_delivered()
   where entity_id = bid::text;
  if n_ctl <> 0 then
    raise exception 'the control fires on a CORRECTLY settled redemption — that is permanent noise (% rows)', n_ctl;
  end if;
  raise notice 'the control is silent on the correctly settled row';

  -- And it sees the historical rows the old body left behind.
  update public.promo_redemptions set benefit_cents = 355 where booking_id = bid;
  select count(*) into n_ctl from public.ctl_discount_settled_above_delivered()
   where entity_id = bid::text;
  if n_ctl <> 1 then
    raise exception 'the control is blind to a redemption charged 355c against 178c delivered (% rows)', n_ctl;
  end if;
  raise notice 'discriminates: the control reports the over-charged row the old body would have written';

  if not exists (select 1 from public.controls
                  where key = 'discount_settled_above_delivered' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  -- ── A FULL capture must be unchanged ──────────────────────────────────────
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid2;
  update public.bookings
     set amount_cents_quoted = 10000, fee_bps_quoted = 700,
         fee_credit_cents = 0, poster_discount_cents = 355
   where id = bid2;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     status, captured_at, earnings_credited)
  values (bid2, 'pi_full_discount_probe', 9645, 345, 9300, 'captured', now(), true);
  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (grant_id, promo, uid, bid2, 700, 355);

  perform public.settle_booking_benefits(bid2, 10000);
  select benefit_cents into benefit2 from public.promo_redemptions where booking_id = bid2;
  if benefit2 <> 355 then
    raise exception 'REGRESSION: a FULL capture settled the discount at %c, not the whole 355c', benefit2;
  end if;
  raise notice 'a full capture still charges the whole 355c — the scaling only bites on a partial';

  -- And the fee_override branch still prices at the BOOKING's rate (20260813140000).
  if public.promo_benefit_cents(10000, 0, '2026-08-01'::timestamptz)
     = public.promo_benefit_cents(10000, 0, now()) then
    raise notice 'rate card is flat across those dates; the booking-time counterfactual cannot be re-proved here';
  else
    raise notice 'the fee_override counterfactual still follows the booking, not the clock';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'partial-capture discount probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
