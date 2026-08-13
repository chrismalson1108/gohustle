-- ─────────────────────────────────────────────────────────────────────────────
-- A fee-override campaign is charged its per-use cap but DELIVERS the whole saving.
--
-- consume_promo_grant:
--     hit := least(p.max_benefit_cents, promo_benefit_cents(p_amount_cents, g.fee_bps));
--     ... spent_cents := spent_cents + hit          ← CHARGED: capped
--     return g.fee_bps;                             ← DELIVERED: the full override rate
--
-- The returned rate is what gets pinned onto the booking as fee_bps_quoted, so the
-- earner receives the entire fee reduction while the campaign's ledger is debited only
-- max_benefit_cents. On a large gig the gap is the whole point of the cap:
--
--     standing 700 bps, override 0 bps, $10,000 gig
--     true saving delivered  = $700
--     campaign charged (cap) = $150
--     → 4.7× more given away than budgeted, and budget_cents never sees it
--
-- settle_booking_benefits re-applies the same cap at capture, so the understatement
-- survives settlement. This is the second half of the same wrong idea as
-- 20260813040000: a benefit's COST and the benefit DELIVERED are treated as separate
-- numbers, and only one of them is bounded.
--
-- ── WHICH WAY TO FIX IT ─────────────────────────────────────────────────────
--
-- Two options: charge the true saving (let budget_cents bind on reality), or deliver
-- only what the cap pays for. The second is correct here, because `max_benefit_cents`
-- is a per-USE cap on a promotions table whose entire documented purpose is "loss is
-- bounded by construction". A cap that silently permits 4.7× is not a cap.
--
-- So the delivered rate is now clamped to the cheapest rate the cap actually buys.
-- Solving for it is plain algebra rather than a search:
--
--     benefit(bps) = fee(standing) - fee(bps)  ≤  cap
--     fee(bps) ≥ fee(standing) - cap
--     bps      ≥ 10000 · (fee(standing) - cap) / amount
--
-- ceil() keeps the delivered benefit at or under the cap rather than a cent over, and
-- the result is never allowed below the campaign's own fee_bps (a cap must not make an
-- override CHEAPER than advertised) nor above the standing rate (it must never make
-- someone worse off than having no promotion at all).
--
-- DORMANT: 1 promotion row, 0 grants, 0 redemptions. Nothing delivered yet.
-- ─────────────────────────────────────────────────────────────────────────────

-- The cheapest rate `p_cap_cents` of benefit actually buys on a gig of `p_amount_cents`.
create or replace function public.capped_override_bps(
  p_amount_cents integer,
  p_grant_bps    integer,
  p_cap_cents    integer
) returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  standing_bps int;
  standing_fee int;
  needed_fee   int;
  min_bps      int;
begin
  if p_amount_cents is null or p_amount_cents <= 0 or p_grant_bps is null then
    return p_grant_bps;
  end if;
  -- No cap configured ⇒ the grant's rate stands.
  if p_cap_cents is null then return p_grant_bps; end if;

  standing_bps := public.fee_bps_at(now());
  standing_fee := public.platform_fee_cents(p_amount_cents, standing_bps);

  -- The fee the poster must still generate for the give-away to stay within the cap.
  needed_fee := greatest(0, standing_fee - greatest(0, p_cap_cents));

  -- ceil, so the delivered benefit lands at or under the cap rather than a cent over.
  min_bps := ceil((needed_fee::numeric * 10000) / p_amount_cents)::int;

  -- Never cheaper than advertised, never worse than no promotion at all.
  return least(standing_bps, greatest(p_grant_bps, min_bps));
end;
$$;

revoke execute on function public.capped_override_bps(integer, integer, integer) from public, anon;

-- ── Reproduced from the LIVE body, with the delivered rate clamped ──────────
create or replace function public.consume_promo_grant(p_user uuid, p_booking uuid, p_amount_cents integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g   public.promo_grants%rowtype;
  p   public.promotions%rowtype;
  hit integer;
  eff integer;
begin
  if p_user is null or p_booking is null then return null; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return null;
  end if;
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
  if not found then return null; end if;
  select * into p from public.promotions where id = g.promotion_id;

  -- THE RATE ACTUALLY DELIVERED, clamped to what the per-use cap pays for. Previously
  -- g.fee_bps was returned unclamped while only `hit` was capped, so a campaign could
  -- give away several times its own per-use ceiling.
  eff := public.capped_override_bps(p_amount_cents, g.fee_bps, p.max_benefit_cents);

  -- The worst case cost of this use, measured against the rate the user would
  -- OTHERWISE have paid, and now measured against the rate we will actually deliver.
  -- Settled to the real figure at capture.
  hit := least(p.max_benefit_cents, public.promo_benefit_cents(p_amount_cents, eff));

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
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (g.id, p.id, p_user, p_booking, eff, hit);
  return eff;
end;
$$;

revoke execute on function public.consume_promo_grant(uuid, uuid, integer) from public, anon, authenticated;

do $$
declare
  delivered int;
  charged   int;
begin
  -- $10,000 gig, override to 0 bps, $150 per-use cap. Before this change the earner
  -- received the full standing fee as a saving while the campaign paid the cap.
  delivered := public.promo_benefit_cents(1000000, public.capped_override_bps(1000000, 0, 15000));
  charged   := least(15000, delivered);
  if delivered > 15000 then
    raise exception 'delivered benefit % still exceeds the % cap', delivered, 15000;
  end if;
  raise notice 'capped override: delivers % cents against a % cap (charged %)',
    delivered, 15000, charged;
end $$;
