-- The console's campaign cost preview renders the standing rate as "7.%", and tells a
-- bonus campaign about a fee waiver it does not have.
--
-- ── 1. "the standing rate of 7.%" ──────────────────────────────────────────
--
-- `to_char(fee_bps / 100.0, 'FM990.99')`. FM strips insignificant zeros, so an exact
-- 7.00 comes out as "7." — the digits go and the decimal point stays. Every rate that is
-- a whole percentage renders this way, which is every rate the platform has ever set:
-- 1000 -> "10.", 700 -> "7.", 500 -> "5.". Verified against production 2026-09-08; the
-- live note reads "Estimated on a typical gig at the standing rate of 7.%".
--
-- This is the sentence an operator reads while choosing `budget_cents` and
-- `max_redemptions` on /promotions — the one screen where a wrong-looking number should
-- make someone stop. A stray decimal point makes the whole preview look unreliable, and
-- 20260906075000 exists precisely because this preview was quoting the wrong rate before.
--
-- ── 2. The caveat is fee-waiver copy shown on every kind ───────────────────
--
-- "A fee waiver costs less than its headline because the processing floor is still
-- collected, and an earner already on a loyalty tier costs less again — so a fee figure
-- is an upper bound." That is true of `fee_override` and true of nothing else:
--
--   * a `bonus` costs its FACE VALUE. 500c is 500c; no floor, no tier, not an upper
--     bound. Telling the operator it is an upper bound invites them to under-budget.
--   * a `poster_discount` is clamped to the headroom above the processing floor, which
--     IS an upper bound but for a different reason, and the figure shown is already the
--     clamped one — on the default $50 gig a 300c discount previews as 150c.
--
-- The arithmetic is untouched. It was checked against production and is correct for all
-- three kinds; only the prose was wrong.

create or replace function public.estimate_campaign_cost(
  p_kind text,
  p_fee_bps integer,
  p_discount_cents integer,
  p_bonus_cents integer,
  p_uses integer,
  p_redemptions integer,
  p_typical_gig_cents integer default 5000
) returns jsonb
language sql
stable
as $function$
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
            -- trim the trailing '.' FM leaves behind on a whole percentage. 700 -> '7',
            -- 750 -> '7.5', 1000 -> '10'.
            || rtrim(trim(to_char(public.fee_bps_at(now()) / 100.0, 'FM990.99')), '.')
            || '%. '
            || case p_kind
                 when 'fee_override' then
                   'A fee waiver costs less than its headline because the processing '
                   || 'floor is still collected, and an earner already on a loyalty tier '
                   || 'costs less again — so this is an upper bound.'
                 when 'poster_discount' then
                   'A discount is capped at the headroom above the processing floor, so '
                   || 'the figure above is already the clamped one — a larger discount on '
                   || 'a gig this size would not cost more.'
                 else
                   'A bonus costs its face value: no processing floor and no loyalty tier '
                   || 'reduces it, so this is the real figure rather than an upper bound.'
               end
  )
$function$;

comment on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer) is
  'Cost preview for a campaign, priced at the STANDING rate from platform_rates — never '
  'a literal. A fee_override figure is an upper bound: the charge is measured against the '
  'booking''s pinned baseline, which a loyalty tier can lower further. A bonus figure is '
  'exact. A poster_discount figure is already clamped to the headroom.';

revoke execute on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer)
  from public, anon;

-- ── Probe ─────────────────────────────────────────────────────────────────
do $$
declare
  n_fee jsonb; n_disc jsonb; n_bonus jsonb;
  standing int := public.fee_bps_at(now());
begin
  select public.estimate_campaign_cost('fee_override', 0, 0, 0, 1, 20, 5000) into n_fee;
  select public.estimate_campaign_cost('poster_discount', 0, 300, 0, 1, 20, 5000) into n_disc;
  select public.estimate_campaign_cost('bonus', 0, 0, 500, 1, 20, 5000) into n_bonus;

  -- 1. No dangling decimal point, at any whole rate.
  if (n_fee ->> 'note') like '%.\%%' then
    raise exception 'FIX FAILED: the rate still renders with a dangling decimal — %', n_fee ->> 'note';
  end if;
  if (n_fee ->> 'note') not like ('%standing rate of ' || (standing / 100)::text || '%%') then
    raise exception 'FIX FAILED: the note does not name the standing rate cleanly — %', n_fee ->> 'note';
  end if;

  -- 2. Each kind gets its own caveat, and only fee_override claims an upper bound.
  if (n_bonus ->> 'note') like '%fee waiver%' then
    raise exception 'FIX FAILED: a bonus campaign is still told about a fee waiver';
  end if;
  if (n_bonus ->> 'note') not like '%face value%' then
    raise exception 'FIX FAILED: a bonus campaign is not told its figure is exact';
  end if;
  if (n_disc ->> 'note') not like '%clamped%' then
    raise exception 'FIX FAILED: a discount campaign is not told the figure is clamped';
  end if;

  -- 3. The ARITHMETIC is unchanged — this migration is prose and formatting only.
  if (n_bonus ->> 'per_use_cents')::int <> 500 then
    raise exception 'FIX FAILED: bonus per-use moved (expected 500, got %)', n_bonus ->> 'per_use_cents';
  end if;
  if (n_disc ->> 'per_use_cents')::int
     <> least(300, public.poster_discount_headroom(5000, standing)) then
    raise exception 'FIX FAILED: discount per-use moved';
  end if;

  raise notice 'probe: the rate renders cleanly and each campaign kind gets its own caveat';
end $$;
