-- ─────────────────────────────────────────────────────────────────────────────
-- A promo campaign was billed for a discount the loyalty tier had already given.
--
-- pin_booking_amount composes benefits LOWEST-WINS, in this order:
--
--     fee_bps_quoted := fee_bps_at(now())               -- standing rate
--     fee_bps_quoted := least(fee_bps_quoted, tier)     -- loyalty tier
--     fee_bps_quoted := least(fee_bps_quoted, promo)    -- campaign
--
-- Every other benefit in that chain is handed the rate already pinned:
-- consume_fee_credit and consume_poster_discount both take p_fee_bps. The promo was
-- the one exception — consume_promo_grant took only (user, booking, amount), and
-- priced its own cost with promo_benefit_cents, which counterfactuals against
-- fee_bps_at(now()): THE STANDING RATE, blind to the tier that has already lowered it.
--
--     hit := least(max_benefit_cents, fee@standing - fee@grant)
--
-- The cost of a benefit is the difference it MAKES. Measured against a baseline the
-- earner was never going to pay, that number is the campaign being charged for the
-- tier's giveaway as well as its own — or for nothing at all.
--
-- ── WHAT IT COSTS, IN CENTS ────────────────────────────────────────────────
--
-- Standing 1000 bps, earner on the 'Veteran' rung (700), $100 gig, fee floor 345c.
--
--   grant 800 bps:  pin = least(1000,700) = 700, then least(700,800) = 700.
--                   The promo moved NOTHING. The campaign is charged 1000-800 = 200c,
--                   redemptions_used +1, a grant use destroyed, a redemption row written.
--                   settle_booking_benefits recomputes with the same blind
--                   counterfactual, so delta = 0 and the 200c is permanent.
--                   A 50,000c budget dies after 250 bookings having discounted nothing.
--
--   grant 500 bps:  pin = 500. The promo's REAL contribution is 700-500 = 200c.
--                   The campaign is charged 1000-500 = 500c. Overcharge 300c — exactly
--                   the tier's own share. The budget bounds 60% less real discount than
--                   it was set to buy, and /promotions reports a campaign cost inflated
--                   by the tier.
--
-- No user is overcharged: lowest-wins means the earner always gets the best rate.
-- The damage is that a bounded campaign's budget is spent on benefit it did not cause,
-- and a user's "first 2 gigs free" use is burned on a gig it made no difference to.
-- Same family as 20260806320000 (poster discount charged, delivered zero) and the same
-- rule: DECIDE BEFORE CHARGING, and measure against what would actually have happened.
--
-- ── DORMANT, ONE CLICK FROM LIVE ───────────────────────────────────────────
-- 20260806120000 seeds all three rungs with enabled = false and tier_fee_bps filters on
-- `where t.enabled`, so today it returns null and the tier least() is a no-op. The
-- defect fires deterministically from the moment someone enables a rung on /pricing,
-- which is the entire point of shipping the ladder. Fix it while it is still cheap.
--
-- ── THE SAME BUG IN settle_booking_benefits, ON THE OTHER KIND ─────────────
-- Found while fixing this. settle loops over ALL promo_redemptions for a booking and
-- recomputes every one as a FEE counterfactual. A poster_discount redemption stores
-- fee_bps = the booking's pinned rate, so on a normal booking
-- promo_benefit_cents(amount, fee_bps_quoted) = fee@standing - fee@standing = 0.
-- settle therefore books actual = 0 and refunds the whole reserve:
-- a $5 poster discount that WAS delivered leaves spent_cents back at zero at capture.
-- budget_cents then bounds nothing for poster-discount campaigns — only max_redemptions
-- does, at whatever per-use value the campaign carries. A discount is a flat cent
-- amount, not a rate delta; settle now recognises the kind instead of assuming.
--
-- Reproduced from the LIVE pg_proc bodies. consume_promo_grant keeps the
-- promotions_enabled kill switch, the revoked_at check, the kind filter, the
-- for-update grant lock and the increment-IS-the-check ceiling UPDATE. The pin keeps
-- the tier/promo ordering, every per-benefit exception handler, the credit passed into
-- consume_poster_discount, the belt-and-braces headroom clamp, and the non-service_role
-- UPDATE branch that re-pins all four columns. Only the counterfactual changes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The baseline becomes evidence, not an assumption ────────────────────────
-- Stored so settle can re-derive the same number at capture without guessing, and so a
-- control can check the charge against it years later. Nullable: rows written before
-- this migration have no honest value, and the control treats a NEW null as a signal
-- that the pin has been reverted to a stale definition.
alter table public.promo_redemptions
  add column if not exists baseline_bps integer;

comment on column public.promo_redemptions.baseline_bps is
  'The rate this earner would have paid WITHOUT this promo (standing rate after any '
  'loyalty tier). reserved_cents is the fee difference measured against THIS, not '
  'against the standing rate — a campaign must not be billed for the tier''s giveaway.';

-- ── The counterfactual, against an explicit baseline ────────────────────────
create or replace function public.promo_benefit_cents(
  p_amount_cents integer, p_fee_bps integer, p_baseline_bps integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(0,
    public.platform_fee_cents(p_amount_cents, coalesce(p_baseline_bps, public.fee_bps_at(now())))
  - public.platform_fee_cents(p_amount_cents, p_fee_bps))
$$;

revoke execute on function public.promo_benefit_cents(integer, integer, integer)
  from public, anon, authenticated;

-- The 2-arg form stays and DELEGATES, so there is exactly one arithmetic body. It means
-- "no baseline known — assume the standing rate", which is the honest reading for the
-- legacy rows settle still has to close out.
create or replace function public.promo_benefit_cents(p_amount_cents integer, p_fee_bps integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select public.promo_benefit_cents(p_amount_cents, p_fee_bps, public.fee_bps_at(now()))
$$;

revoke execute on function public.promo_benefit_cents(integer, integer) from public, anon, authenticated;

-- ── Consume against the baseline, and refuse to charge for nothing ──────────
create or replace function public.consume_promo_grant(
  p_user uuid, p_booking uuid, p_amount_cents integer, p_baseline_bps integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g        public.promo_grants%rowtype;
  p        public.promotions%rowtype;
  baseline integer;
  hit      integer;
begin
  if p_user is null or p_booking is null then return null; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return null;
  end if;

  -- A missing baseline means a caller that has not been updated. Fall back to the
  -- standing rate — the old behaviour — rather than pricing against null.
  baseline := coalesce(p_baseline_bps, public.fee_bps_at(now()));

  -- ORDER BY fee_bps ASC picks the single BEST grant, which is what makes the
  -- short-circuit below complete: if the lowest eligible grant cannot beat the
  -- baseline, none of them can.
  select g2.* into g
    from public.promo_grants g2
    join public.promotions p2 on p2.id = g2.promotion_id
   where g2.user_id = p_user
     and g2.uses_consumed < g2.uses_allowed
     and g2.revoked_at is null
     and (g2.expires_at is null or g2.expires_at > now())
     and p2.kind = 'fee_override'
     and p2.status = 'active'
     and p2.starts_at <= now()
     and (p2.ends_at is null or p2.ends_at > now())
   order by g2.fee_bps asc nulls last
   limit 1
   for update of g2;

  if not found or g.fee_bps is null then return null; end if;

  -- DECIDE BEFORE CHARGING. The grant cannot improve on what this booking is already
  -- pinned at, so it delivers nothing: charge nothing, burn nothing, write nothing.
  -- The use stays on the grant for a booking where it actually helps.
  if g.fee_bps >= baseline then return null; end if;

  select * into p from public.promotions where id = g.promotion_id;

  -- The worst-case cost of this use, measured against the rate the earner would
  -- OTHERWISE have paid on THIS booking — standing rate after any loyalty tier, not
  -- the standing rate alone. Settled to the real figure at capture.
  hit := least(p.max_benefit_cents, public.promo_benefit_cents(p_amount_cents, g.fee_bps, baseline));

  -- Both fees can land on the Stripe processing floor, in which case the rate
  -- difference buys the earner literally nothing. Same rule as above.
  if hit <= 0 then return null; end if;

  -- The increment IS the check: one conditional UPDATE carrying both ceilings, never
  -- read-then-decide.
  update public.promotions
     set redemptions_used = redemptions_used + 1,
         spent_cents      = spent_cents + hit
   where id = p.id
     and redemptions_used < max_redemptions
     and spent_cents + hit <= budget_cents;
  if not found then
    return null;
  end if;

  update public.promo_grants set uses_consumed = uses_consumed + 1 where id = g.id;

  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, baseline_bps, reserved_cents)
  values (g.id, p.id, p_user, p_booking, g.fee_bps, baseline, hit);

  return g.fee_bps;
end;
$$;

revoke execute on function public.consume_promo_grant(uuid, uuid, integer, integer)
  from public, anon, authenticated;

-- The 3-argument version is gone, for the same reason 20260806320000 dropped the
-- 4-argument consume_poster_discount: leaving it lets a caller silently get the
-- baseline-blind behaviour, which IS the bug.
drop function if exists public.consume_promo_grant(uuid, uuid, integer);

-- ── Settle against the same baseline, and stop treating a flat discount as a rate ──
create or replace function public.settle_booking_benefits(p_booking uuid, p_amount_cents integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r      public.promo_redemptions%rowtype;
  kind   text;
  actual int;
  delta  int;
  n      int := 0;
begin
  if p_booking is null or p_amount_cents is null then return 0; end if;

  for r in
    select * from public.promo_redemptions
     where booking_id = p_booking
       and released_at is null
       and settled_at is null
     for update
  loop
    select p.kind into kind from public.promotions p where p.id = r.promotion_id;

    if kind = 'poster_discount' then
      -- A poster discount is a FLAT cent amount, already clamped to the fundable
      -- headroom at pin time. Recomputing it as a fee-rate difference — which is what
      -- this loop used to do to every redemption — evaluates to zero on any booking
      -- pinned at the standing rate and hands the campaign its whole reserve back, so
      -- budget_cents stopped bounding poster-discount spend at all. The delivered
      -- amount is the number on the booking.
      select coalesce(b.poster_discount_cents, r.reserved_cents) into actual
        from public.bookings b where b.id = r.booking_id;
      actual := least(coalesce(actual, r.reserved_cents), r.reserved_cents);
    else
      -- The true cost of this fee override, against the baseline this booking was
      -- actually priced from, never more than the campaign's per-use cap.
      actual := least(
        coalesce((select max_benefit_cents from public.promotions where id = r.promotion_id),
                 r.reserved_cents),
        public.promo_benefit_cents(p_amount_cents, r.fee_bps,
                                   coalesce(r.baseline_bps, public.fee_bps_at(now()))));
    end if;

    delta := actual - r.reserved_cents;

    -- Normally negative — the reserve was the worst case. A positive delta was
    -- previously possible only because the counterfactual re-read fee_bps_at(now()) at
    -- capture; pinning baseline_bps removes that source of drift, and the campaign's
    -- own ceiling still bounds whatever remains.
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
$$;

revoke execute on function public.settle_booking_benefits(uuid, integer) from public, anon, authenticated;

-- ── Pass the pinned rate through ────────────────────────────────────────────
-- Reproduced from the live pin with ONE changed call. The tier still runs first, so
-- the baseline handed to the promo is the rate after the tier — which is the whole
-- point.
create or replace function public.pin_booking_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j        record;
  promoBps integer;
  tierBps  integer;
begin
  if tg_op = 'INSERT' then
    select pay, pay_type, estimated_hours, poster_id into j
      from public.jobs where id = new.job_id;
    if not found or j.pay is null then
      return new;
    end if;

    new.amount_cents_quoted := round(
      coalesce(new.counter_offer, j.pay)
      * (case when j.pay_type = 'hourly' then coalesce(j.estimated_hours, 1) else 1 end)
      * 100
    )::integer;

    new.fee_bps_quoted := public.fee_bps_at(now());

    -- Loyalty tier: standing policy, no budget, no expiry. Lowest wins.
    begin
      tierBps := public.tier_fee_bps(new.earner_id);
      if tierBps is not null then
        new.fee_bps_quoted := least(new.fee_bps_quoted, tierBps);
      end if;
    exception when others then
      raise warning 'tier lookup failed for booking %: %', new.id, sqlerrm;
    end;

    -- Promotion: a bounded campaign. Also lowest-wins, never additive — two benefits
    -- summing could drive the rate below the floor by accident.
    --
    -- The pinned rate is passed in so the campaign is charged for the difference it
    -- ACTUALLY makes. Without it the counterfactual was the standing rate, and a
    -- campaign was billed for the loyalty tier's giveaway on top of its own — or for
    -- nothing, when the tier already beat the grant.
    begin
      promoBps := public.consume_promo_grant(
        new.earner_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted);
      if promoBps is not null then
        new.fee_bps_quoted := least(new.fee_bps_quoted, promoBps);
      end if;
    exception when others then
      raise warning 'promo application failed for booking %: %', new.id, sqlerrm;
    end;

    begin
      new.fee_credit_cents := coalesce(public.consume_fee_credit(
        new.earner_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted), 0);
    exception when others then
      new.fee_credit_cents := 0;
      raise warning 'fee credit application failed for booking %: %', new.id, sqlerrm;
    end;

    begin
      -- The credit is passed in so the discount is sized against the headroom that is
      -- ACTUALLY LEFT. Without it the campaign was charged for a discount this clamp
      -- then reduced to zero.
      new.poster_discount_cents := coalesce(public.consume_poster_discount(
        j.poster_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted,
        coalesce(new.fee_credit_cents, 0)), 0);
      -- Kept as a belt-and-braces clamp. It should now never bind; if it ever does,
      -- the two calculations have drifted and this is what stands between that and a
      -- negative application_fee_amount at Stripe.
      new.poster_discount_cents := least(
        new.poster_discount_cents,
        greatest(0, public.poster_discount_headroom(new.amount_cents_quoted, new.fee_bps_quoted)
                    - coalesce(new.fee_credit_cents, 0)));
    exception when others then
      new.poster_discount_cents := 0;
      raise warning 'poster discount failed for booking %: %', new.id, sqlerrm;
    end;

    return new;
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.amount_cents_quoted    := old.amount_cents_quoted;
    new.fee_bps_quoted         := old.fee_bps_quoted;
    new.fee_credit_cents       := old.fee_credit_cents;
    new.poster_discount_cents  := old.poster_discount_cents;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_booking_amount() from public, anon, authenticated;

-- ── Control ─────────────────────────────────────────────────────────────────
-- ctl_discount_charged_not_delivered covers the same failure for kind='poster_discount'
-- and explicitly filters it out of scope; this is its fee_override half, which is why
-- the bug above could run for as long as it liked without anything noticing.
create or replace function public.ctl_promo_charged_not_delivered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  -- charged = what the campaign's budget is actually carrying right now: the worst-case
  -- reserve until capture settles it, the settled figure afterwards. Comparing against
  -- reserved_cents alone would re-flag every correctly-settled row forever.
  with r as (
    select rr.*,
           case when rr.settled_at is null then rr.reserved_cents else rr.benefit_cents end
             as charged_cents
      from public.promo_redemptions rr
  )
  select r.booking_id::text,
         jsonb_build_object(
           'promotion_id',   r.promotion_id,
           'charged_cents',  r.charged_cents,
           'reserved_cents', r.reserved_cents,
           'grant_fee_bps',  r.fee_bps,
           'baseline_bps',   r.baseline_bps,
           'pinned_fee_bps', b.fee_bps_quoted,
           'amount_cents',   b.amount_cents_quoted,
           'true_benefit_cents',
             case when r.baseline_bps is null then null
                  else greatest(0,
                    public.platform_fee_cents(b.amount_cents_quoted, r.baseline_bps)
                  - public.platform_fee_cents(b.amount_cents_quoted, r.fee_bps)) end,
           'booking_status', b.status)
    from r
    join public.bookings b   on b.id = r.booking_id
    join public.promotions p on p.id = r.promotion_id
   where p.kind = 'fee_override'
     and r.released_at is null
     and r.charged_cents > 0
     and (
       -- (a) The campaign was charged but the booking is NOT pinned at the grant's
       -- rate, so lowest-wins settled on something else and the promo delivered
       -- nothing. Post-fix this is impossible: consume_promo_grant returns null
       -- without charging when it cannot beat the baseline.
       b.fee_bps_quoted <> r.fee_bps

       -- (b) The charge exceeds the benefit measured against this booking's own
       -- baseline — i.e. the campaign is paying for someone else's discount.
       or (r.baseline_bps is not null
           and r.charged_cents > greatest(0,
                 public.platform_fee_cents(b.amount_cents_quoted, r.baseline_bps)
               - public.platform_fee_cents(b.amount_cents_quoted, r.fee_bps)))

       -- (c) A redemption written AFTER this migration with no baseline recorded means
       -- the pin is calling a stale consume_promo_grant. The fix having been reverted
       -- is exactly as important to hear about as the bug itself.
       or (r.baseline_bps is null and r.created_at > timestamptz '2026-08-12 07:00:00+00')
     )
$$;

revoke execute on function public.ctl_promo_charged_not_delivered() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('promo_charged_not_delivered',
   'A fee-override campaign was charged more than the booking actually received',
   'high', 'money',
   'The pin composes standing rate, loyalty tier and promo by lowest-wins. If the promo '
   'prices itself against the standing rate instead of the rate already pinned, the '
   'campaign is billed for the tier''s giveaway as well as its own — or for nothing at '
   'all when the tier already beat the grant — and the earner''s grant use is burned '
   'for a booking it made no difference to. budget_cents then bounds far less real '
   'discount than it was set to buy, and the campaign exhausts against earners who '
   'never received anything.',
   'ctl_promo_charged_not_delivered')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
