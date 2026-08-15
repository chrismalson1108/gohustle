-- ─────────────────────────────────────────────────────────────────────────────
-- A campaign paid for a benefit the loyalty tier had already given away.
--
-- pin_booking_amount applies the two supply-side benefits lowest-wins:
--     new.fee_bps_quoted := fee_bps_at(now());
--     tier  → least(standing, tier_fee_bps(earner))      -- standing policy, free
--     promo → least(that,     consume_promo_grant(...))  -- bounded campaign, costed
--
-- but consume_promo_grant measures its own cost against `fee_bps_at(now())` — the
-- STANDING rate — never against the rate the booking is actually pinned at. The tier is
-- invisible to it.
--
-- So for an earner already on a tier at or below the promo's rate:
--   · promo_benefit_cents charges the campaign the full standing→promo difference,
--   · a use is burned off a grant that has a finite uses_allowed,
--   · and the earner's pinned rate does not move by a single basis point, because
--     least() had already taken the tier.
--
-- The campaign's budget drains against deliveries that never happened, which defeats the
-- one property this system is built around: "loss is bounded by construction". The bound
-- holds arithmetically and stops meaning what it says.
--
-- Found by the 2026-08-12 payments audit. The 2026-08-13 rewrite
-- (20260813140000_settle_benefits_at_booking_rate) is NOT this fix: it changed WHICH
-- MOMENT the standing rate is read at (now() → the booking's created_at). It did not
-- change WHICH RATE is the baseline. Both are still the standing card.
--
-- ── THE CHANGE ──────────────────────────────────────────────────────────────
-- A 4-arg consume_promo_grant taking the ALREADY-PINNED baseline, and the 3-arg form
-- dropped in the SAME transaction. Both matter:
--   · dropping it is what stops `consume_promo_grant(uuid, uuid, integer)` becoming
--     ambiguous — 20260813140000's own header records that trap, where leaving the old
--     2-arg promo_benefit_cents in place made every caller fail with "function is not
--     unique";
--   · and a leftover 3-arg overload would be the silent path back to the bug.
--
-- capped_override_bps also reads fee_bps_at(now()) internally for the same purpose, so it
-- gains a baseline argument too, with its 3-arg form kept — it has other callers and its
-- default preserves today's behaviour for them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── capped_override_bps: same shape, baseline supplied ──────────────────────
create or replace function public.capped_override_bps(
  p_amount_cents integer,
  p_grant_bps    integer,
  p_cap_cents    integer,
  -- The rate the booking would otherwise pay. Defaults to the standing card so the
  -- existing 3-arg callers are unchanged.
  p_baseline_bps integer default null
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
  if p_cap_cents is null then return p_grant_bps; end if;

  standing_bps := coalesce(p_baseline_bps, public.fee_bps_at(now()));
  standing_fee := public.platform_fee_cents(p_amount_cents, standing_bps);

  needed_fee := greatest(0, standing_fee - greatest(0, p_cap_cents));
  min_bps := ceil((needed_fee::numeric * 10000) / p_amount_cents)::int;

  return least(standing_bps, greatest(p_grant_bps, min_bps));
end;
$$;

-- ── The 3-arg form must GO, not merely be superseded ────────────────────────
drop function if exists public.consume_promo_grant(uuid, uuid, integer);

create or replace function public.consume_promo_grant(
  p_user         uuid,
  p_booking      uuid,
  p_amount_cents integer,
  -- What this booking would pay WITHOUT the promotion — i.e. after the standing rate and
  -- the loyalty tier have already been taken. This is the whole fix.
  p_baseline_bps integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g   public.promo_grants%rowtype;
  p   public.promotions%rowtype;
  hit integer;
  eff integer;
  base integer;
begin
  if p_user is null or p_booking is null then return null; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return null;
  end if;

  -- A caller that cannot supply a baseline gets the old behaviour rather than a crash.
  base := coalesce(p_baseline_bps, public.fee_bps_at(now()));

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

  -- ── Nothing to deliver ⇒ charge nothing and burn nothing ──────────────────
  -- The grant is no better than what this booking already gets. Returning null here
  -- leaves uses_consumed, spent_cents and redemptions_used untouched, so the grant stays
  -- available for a booking where it WOULD move the rate. Previously this path charged
  -- the campaign the full standing→promo difference and consumed a use, while least()
  -- upstream discarded the result.
  if g.fee_bps is not null and g.fee_bps >= base then
    return null;
  end if;

  select * into p from public.promotions where id = g.promotion_id;

  eff := public.capped_override_bps(p_amount_cents, g.fee_bps, p.max_benefit_cents, base);

  -- Measured against the BASELINE, not the standing card: the benefit is the fee the
  -- booking would have paid minus the fee it will pay.
  hit := least(
    p.max_benefit_cents,
    greatest(0, public.platform_fee_cents(p_amount_cents, base)
              - public.platform_fee_cents(p_amount_cents, eff))
  );

  -- The cap may have clamped the delivered rate back to the baseline, or rounding may
  -- leave nothing. Same rule as above: no delivery, no charge, no use burned.
  if hit <= 0 or eff >= base then
    return null;
  end if;

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

revoke execute on function public.consume_promo_grant(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_promo_grant(uuid, uuid, integer, integer) to service_role;

-- ── The caller passes the pinned rate ───────────────────────────────────────
-- Only the one line changes; everything else is the 20260806320000 body verbatim.
do $$
declare src text; patched text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'pin_booking_amount';
  if src is null then raise exception 'pin_booking_amount not found'; end if;

  patched := replace(
    src,
    'public.consume_promo_grant(new.earner_id, new.id, new.amount_cents_quoted)',
    'public.consume_promo_grant(new.earner_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted)');

  if patched = src then
    raise exception 'pin_booking_amount does not call consume_promo_grant in the expected shape — refusing to patch blind';
  end if;
  execute patched;
end $$;

-- ── Prove it discriminates ──────────────────────────────────────────────────
do $$
declare
  uid uuid; promo uuid; grant_id uuid;
  spent_before int; used_before int; consumed_before int;
  spent_after int; used_after int; consumed_after int;
  res int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- A campaign offering 700 bps to an earner whose baseline is ALREADY 700.
  insert into public.promotions
    (name, kind, status, fee_bps, budget_cents, max_redemptions, max_benefit_cents, starts_at)
  values ('probe override', 'fee_override', 'active', 500, 100000, 100, 100000, now() - interval '1 day')
  returning id into promo;
  insert into public.promo_grants (user_id, promotion_id, uses_allowed, fee_bps)
  values (uid, promo, 1, 500) returning id into grant_id;

  select spent_cents, redemptions_used into spent_before, used_before
    from public.promotions where id = promo;
  select uses_consumed into consumed_before from public.promo_grants where id = grant_id;

  -- Baseline 500 — the earner's tier already gives exactly what this promo offers, while
  -- the STANDING card is higher. That gap is what the old form charged for.
  res := public.consume_promo_grant(uid, gen_random_uuid(), 20000, 500);

  select spent_cents, redemptions_used into spent_after, used_after
    from public.promotions where id = promo;
  select uses_consumed into consumed_after from public.promo_grants where id = grant_id;

  if res is not null then
    raise exception 'FIX FAILED: a promo matching the baseline still returned a rate (%)', res;
  end if;
  if spent_after <> spent_before or used_after <> used_before or consumed_after <> consumed_before then
    raise exception 'FIX FAILED: campaign charged %c / uses % for a benefit worth nothing',
      spent_after - spent_before, consumed_after - consumed_before;
  end if;

  -- What the OLD behaviour would have charged on this same grant: the full
  -- standing→promo difference, measured against the rate card rather than the baseline.
  if public.platform_fee_cents(20000, public.fee_bps_at(now())) - public.platform_fee_cents(20000, 500) <= 0 then
    raise exception 'probe is not discriminating: the standing rate equals the promo rate, so the old form charged nothing either';
  end if;
  raise notice 'discriminates: old form would have charged %c and burned a use for zero delivery; new form charges nothing',
    public.platform_fee_cents(20000, public.fee_bps_at(now())) - public.platform_fee_cents(20000, 500);

  -- And a promo that GENUINELY beats the baseline must still apply.
  res := public.consume_promo_grant(uid, gen_random_uuid(), 20000, 1000);
  if res is null then
    raise exception 'OVER-CORRECTED: a promo that beats the baseline no longer applies';
  end if;
  select spent_cents into spent_after from public.promotions where id = promo;
  if spent_after <= spent_before then
    raise exception 'OVER-CORRECTED: a real delivery charged the campaign nothing';
  end if;
  raise notice 'a promo that genuinely beats the baseline still applies (rate %, charged %c)',
    res, spent_after - spent_before;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'promo-baseline probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
