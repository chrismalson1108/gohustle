-- ─────────────────────────────────────────────────────────────────────────────
-- The campaign cost preview priced every benefit against the FOUNDING rate.
--
-- estimate_campaign_cost is what an operator reads before activating a campaign — it is
-- the only number they have when they choose `budget_cents` and `max_redemptions`. Its
-- own comment claims it "uses the real fee functions so the estimate cannot drift from
-- the charge". It does call the real fee functions, and it hands all four of them a
-- literal baseline:
--
--     platform_fee_cents(p_typical_gig_cents, 1000)          -- fee_override, per use
--     poster_discount_headroom(p_typical_gig_cents, 1000)    -- poster_discount, per use
--     …and the same two literals again in max_total_cents.
--
-- 1000 bps is the FOUNDING rate. The standing rate has been 700 bps since 2026-08-12,
-- and the whole point of platform_rates is that the rate is data. CLAUDE.md states the
-- rule this breaks in as many words: never infer the current rate from a code default.
--
-- ── WHAT THE OPERATOR IS TOLD, AND WHAT IS CHARGED ──────────────────────────
-- On the $50 default gig the floor is ceil(5000 × 0.029) + 30 + 25 = 200c.
--
--   a 0% fee_override:  preview  fee(5000,1000) − fee(5000,0) = 500 − 200 = 300c/use
--                       charged  fee(5000, 700) − fee(5000,0) = 350 − 200 = 150c/use
--   a $5 poster discount: preview least(500, headroom@1000 = 300) = 300c/use
--                         charged least(500, headroom@ 700 = 150) = 150c/use
--
-- Exactly 2x at the default gig. The overstatement is not a fixed ratio, because the
-- processing floor is a constant the rate change does not move: it grows on smaller gigs
-- and converges toward 10/7 ≈ 1.43x on larger ones ($200 gig: 1365c quoted, 765c real).
--
-- An operator sizing a campaign off it plans against a burn rate wrong by roughly half.
-- A $250 budget previewed at 300c/use reads as ~83 redemptions; it actually funds ~166,
-- so a max_redemptions chosen from the preview under-delivers the campaign by half. A
-- rate RISE inverts the sign and exhausts the budget early, which is the worse direction.
--
-- ── THIS IS THE THIRD TIME THIS LITERAL HAS BEEN FOUND ──────────────────────
-- The charge path was corrected off exactly the same literal, twice:
--   · 20260806220000_benefit_lifecycle  — "THE BUDGET COUNTERFACTUAL HARDCODED 1000 bps
--     … a 50% undercount, in the unsafe direction". promo_benefit_cents moved to
--     fee_bps_at(now()).
--   · 20260813140000_settle_benefits_at_booking_rate — moved that read to the BOOKING's
--     moment, fee_bps_at(created_at), so a rate change never re-prices agreed work.
-- The preview was written in 20260806170000, between the two, and was never revisited.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Each of the four literals becomes public.fee_bps_at(now()) — the same reader the charge
-- path uses, and the reason platform_rates has a reader at all. fee_bps_at is `stable`,
-- so a `stable` SQL function may call it; nothing else about the shape changes.
--
-- now() is the right moment here, and NOT the booking-time read 20260813140000 chose:
-- this estimates a campaign that has not run yet, so the rate in force today is the only
-- rate there is. If the card is scheduled to move mid-campaign the preview will follow it
-- the day it moves, which is the honest answer to "what would this cost".
--
-- ── WHAT THE PREVIEW STILL CANNOT KNOW, AND NOW SAYS ────────────────────────
-- Since 20260814120000 a fee_override is charged against the booking's PINNED baseline,
-- which is least(standing rate, tier_fee_bps(earner)) — an earner already on a loyalty
-- rung at or below the campaign's rate costs the campaign less, and possibly nothing. The
-- preview is per-campaign and has no earner, so it cannot resolve a tier. It is therefore
-- an UPPER BOUND on fee_override cost even after this fix, and the note it returns — the
-- one the console renders under the figures — now says so and names the rate it used,
-- rather than leaving the operator to assume the number is exact.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.estimate_campaign_cost(
  p_kind text, p_fee_bps integer, p_discount_cents integer,
  p_bonus_cents integer, p_uses integer, p_redemptions integer,
  p_typical_gig_cents integer default 5000
) returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'per_use_cents', case
      when p_kind = 'fee_override' then
        greatest(0, public.platform_fee_cents(p_typical_gig_cents, public.fee_bps_at(now()))
                  - public.platform_fee_cents(p_typical_gig_cents,
                      coalesce(p_fee_bps, public.fee_bps_at(now()))))
      when p_kind = 'poster_discount' then
        least(coalesce(p_discount_cents, 0),
              public.poster_discount_headroom(p_typical_gig_cents, public.fee_bps_at(now())))
      else coalesce(p_bonus_cents, 0)
    end,
    'max_total_cents', case
      when p_kind = 'fee_override' then
        greatest(0, public.platform_fee_cents(p_typical_gig_cents, public.fee_bps_at(now()))
                  - public.platform_fee_cents(p_typical_gig_cents,
                      coalesce(p_fee_bps, public.fee_bps_at(now()))))
        * greatest(1, coalesce(p_uses, 1)) * greatest(1, coalesce(p_redemptions, 1))
      when p_kind = 'poster_discount' then
        least(coalesce(p_discount_cents, 0),
              public.poster_discount_headroom(p_typical_gig_cents, public.fee_bps_at(now())))
        * greatest(1, coalesce(p_redemptions, 1))
      else coalesce(p_bonus_cents, 0) * greatest(1, coalesce(p_redemptions, 1))
    end,
    'typical_gig_cents', p_typical_gig_cents,
    'note', 'Estimated on a typical gig at the standing rate of '
            || trim(to_char(public.fee_bps_at(now()) / 100.0, 'FM990.99')) || '%. '
            || 'A fee waiver costs less than its headline because the processing floor '
            || 'is still collected, and an earner already on a loyalty tier costs less '
            || 'again — so a fee figure is an upper bound.'
  )
$$;

comment on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer) is
  'Cost preview for a campaign, priced at the STANDING rate from platform_rates — never '
  'a literal. A fee_override figure is an upper bound: the charge is measured against the '
  'booking''s pinned baseline, which a loyalty tier can lower further.';

revoke execute on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer)
  to authenticated, service_role;


-- ── Prove the preview now moves with the rate card, and did not before ──────
-- Stages two rate rows either side of 1000 so the probe discriminates whatever the live
-- rate happens to be, and compares against promo_benefit_cents — the function that
-- actually charges a fee_override campaign. Everything is rolled back.
do $$
declare
  quoted   int;
  charged  int;
  old_way  int;
  total    int;
  note_txt text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── Below the founding rate: today's live posture (700 since 2026-08-12) ──
  insert into public.platform_rates (fee_bps, effective_from, note)
  values (700, now() - interval '2 seconds', 'cost-preview probe — rolled back');

  if public.fee_bps_at(now()) <> 700 then
    raise exception 'probe could not stage the rate (fee_bps_at reports %)', public.fee_bps_at(now());
  end if;

  quoted  := (public.estimate_campaign_cost('fee_override', 0, null::int, null::int, 1, 1, 5000) ->> 'per_use_cents')::int;
  charged := public.promo_benefit_cents(5000, 0);
  old_way := greatest(0, public.platform_fee_cents(5000, 1000) - public.platform_fee_cents(5000, 0));

  -- THE DISCRIMINATION: the literal the old body carried gives a different, larger
  -- number. If these were equal the probe would prove nothing.
  if old_way = charged then
    raise exception 'probe is inert: the 1000-bps literal agrees with the standing rate here';
  end if;
  if quoted <> charged then
    raise exception 'FIX FAILED: preview quotes %c/use, the charge path charges %c/use', quoted, charged;
  end if;
  raise notice 'at 700 bps the preview quotes %c/use and promo_benefit_cents charges %c — the old literal said %c', quoted, charged, old_way;

  -- The poster-discount arm reads the same rate, and is clamped by the same headroom the
  -- pin applies at booking.
  quoted  := (public.estimate_campaign_cost('poster_discount', null::int, 500, null::int, 1, 1, 5000) ->> 'per_use_cents')::int;
  charged := least(500, public.poster_discount_headroom(5000, public.fee_bps_at(now())));
  if quoted <> charged then
    raise exception 'FIX FAILED: discount preview says %c, fundable headroom is %c', quoted, charged;
  end if;
  if quoted = least(500, public.poster_discount_headroom(5000, 1000)) then
    raise exception 'the discount arm still agrees with the 1000-bps literal';
  end if;
  raise notice 'a $5 poster discount previews at %c, which is the headroom actually fundable at the standing rate', quoted;

  -- max_total_cents must scale the corrected per-use figure, not a second stale copy of
  -- the arithmetic — both literals lived there too.
  total := (public.estimate_campaign_cost('fee_override', 0, null::int, null::int, 3, 10, 5000) ->> 'max_total_cents')::int;
  if total <> public.promo_benefit_cents(5000, 0) * 3 * 10 then
    raise exception 'FIX FAILED: max_total_cents is %, expected %', total, public.promo_benefit_cents(5000, 0) * 3 * 10;
  end if;
  raise notice 'max_total_cents scales the corrected per-use cost (% for 3 uses x 10 redemptions)', total;

  -- ── Above the founding rate: the error inverts, and so must the fix ───────
  insert into public.platform_rates (fee_bps, effective_from, note)
  values (1500, now() - interval '1 second', 'cost-preview probe — rolled back');

  quoted  := (public.estimate_campaign_cost('fee_override', 0, null::int, null::int, 1, 1, 5000) ->> 'per_use_cents')::int;
  charged := public.promo_benefit_cents(5000, 0);
  if quoted <> charged then
    raise exception 'FIX FAILED at 1500 bps: preview %c, charge %c', quoted, charged;
  end if;
  if quoted <= old_way then
    raise exception 'preview did not rise with the rate — it is still anchored below the card';
  end if;
  raise notice 'at 1500 bps the preview rises to %c, where the old literal would have UNDERSTATED the burn at %c', quoted, old_way;

  -- The note the console renders names the rate it used, so the figure is readable.
  note_txt := public.estimate_campaign_cost('fee_override', 0, null::int, null::int, 1, 1, 5000) ->> 'note';
  if note_txt not like '%15%' then
    raise exception 'the note does not name the rate it priced at: %', note_txt;
  end if;
  if note_txt not like '%upper bound%' then
    raise exception 'the note does not warn that a loyalty tier lowers the real charge: %', note_txt;
  end if;
  raise notice 'note reads: %', note_txt;

  -- A bonus campaign is a flat cash figure and must be untouched by any of this.
  if (public.estimate_campaign_cost('bonus', null::int, null::int, 250, 1, 4, 5000) ->> 'max_total_cents')::int <> 1000 then
    raise exception 'the bonus arm changed; it does not depend on the rate at all';
  end if;
  raise notice 'the bonus arm is unchanged, as it must be — a cash bonus is not fee-derived';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'cost-preview probe passed; both staged rate rows rolled back';
  else
    raise;
  end if;
end $$;
