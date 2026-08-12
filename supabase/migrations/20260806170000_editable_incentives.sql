-- ─────────────────────────────────────────────────────────────────────────────
-- Make the incentive system OPERABLE, not just observable (2026-08-06).
--
-- The console could create a campaign and toggle it, and nothing else. No editing a
-- budget, no extending a run, no adding or changing a loyalty tier, no revoking a grant
-- from someone abusing it. Everything shipped read-mostly, which means the moment a
-- campaign needs a real-world adjustment the only path is hand-written SQL — the exact
-- thing /pricing was built to stop.
--
-- THE RULE THAT MAKES EDITING SAFE
--
-- A grant SNAPSHOTS its benefit (promo_grants.fee_bps) and a booking PINS it
-- (bookings.fee_bps_quoted). So editing a live campaign can never re-price anything
-- anyone already holds — the edit reaches future claims only. That property is what
-- lets these be ordinary edits instead of dangerous ones, and it is why the guards
-- below are about ARITHMETIC (never let spent exceed budget) rather than about
-- freezing records.
--
-- WHAT A BUDGET EDIT MUST NOT DO: silently un-spend money. Lowering budget_cents below
-- spent_cents would make the ceiling check pass again and let a campaign that already
-- overspent keep spending. The CHECK below makes that state unrepresentable.
-- ─────────────────────────────────────────────────────────────────────────────

-- Budget can never be set below what has already been committed.
alter table public.promotions drop constraint if exists promotions_budget_ge_spent;
alter table public.promotions
  add constraint promotions_budget_ge_spent check (budget_cents >= spent_cents);

-- Same for the redemption ceiling.
alter table public.promotions drop constraint if exists promotions_max_ge_used;
alter table public.promotions
  add constraint promotions_max_ge_used check (max_redemptions >= redemptions_used);

-- ── Revoking a grant ─────────────────────────────────────────────────────────
-- Pausing a campaign stops NEW claims; it does nothing about someone already holding
-- one. Revocation is the per-person lever, for abuse or for an offer sent in error.
alter table public.promo_grants
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_reason text;

comment on column public.promo_grants.revoked_at is
  'Set to withdraw an unused grant from one person. Bookings already pinned with it are '
  'untouched — revocation reaches the future only, same as every other edit here.';

-- consume_promo_grant must ignore revoked grants. Reproduced in full.
create or replace function public.consume_promo_grant(
  p_user uuid, p_booking uuid, p_amount_cents integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g   public.promo_grants%rowtype;
  p   public.promotions%rowtype;
  hit integer;
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

  if not found or g.fee_bps is null then return null; end if;
  select * into p from public.promotions where id = g.promotion_id;

  hit := least(p.max_benefit_cents,
               greatest(0, public.platform_fee_cents(p_amount_cents, 1000)
                         - public.platform_fee_cents(p_amount_cents, g.fee_bps)));

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
  values (g.id, p.id, p_user, p_booking, g.fee_bps, hit);

  return g.fee_bps;
end;
$$;

revoke execute on function public.consume_promo_grant(uuid, uuid, integer)
  from public, anon, authenticated;

-- Same for poster discounts.
create or replace function public.consume_poster_discount(
  p_user uuid, p_booking uuid, p_amount_cents integer, p_fee_bps integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g   public.promo_grants%rowtype;
  p   public.promotions%rowtype;
  cap integer;
  hit integer;
begin
  if p_user is null or p_booking is null then return 0; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return 0;
  end if;

  cap := public.poster_discount_headroom(p_amount_cents, p_fee_bps);
  if cap <= 0 then return 0; end if;

  select g2.* into g
    from public.promo_grants g2
    join public.promotions p2 on p2.id = g2.promotion_id
   where g2.user_id = p_user
     and g2.uses_consumed < g2.uses_allowed
     and g2.revoked_at is null
     and (g2.expires_at is null or g2.expires_at > now())
     and p2.kind = 'poster_discount'
     and p2.status = 'active'
     and p2.starts_at <= now()
     and (p2.ends_at is null or p2.ends_at > now())
   order by p2.poster_discount_cents desc nulls last
   limit 1
   for update of g2;
  if not found then return 0; end if;

  select * into p from public.promotions where id = g.promotion_id;
  hit := least(coalesce(p.poster_discount_cents, 0), cap, p.max_benefit_cents);
  if hit <= 0 then return 0; end if;

  update public.promotions
     set redemptions_used = redemptions_used + 1,
         spent_cents      = spent_cents + hit
   where id = p.id
     and redemptions_used < max_redemptions
     and spent_cents + hit <= budget_cents;
  if not found then return 0; end if;

  update public.promo_grants set uses_consumed = uses_consumed + 1 where id = g.id;

  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (g.id, p.id, p_user, p_booking, coalesce(p_fee_bps, 1000), hit)
  on conflict (booking_id) do nothing;

  return hit;
end;
$$;

revoke execute on function public.consume_poster_discount(uuid, uuid, integer, integer)
  from public, anon, authenticated;

-- ── Cost preview ─────────────────────────────────────────────────────────────
-- "What would this campaign cost if it fully redeemed?" answered BEFORE activating,
-- rather than discovered from the burn-down bar afterwards. Uses the real fee functions
-- so the estimate cannot drift from the charge — including the floor, which is why a
-- 0% campaign costs less than the headline suggests.
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
        greatest(0, public.platform_fee_cents(p_typical_gig_cents, 1000)
                  - public.platform_fee_cents(p_typical_gig_cents, coalesce(p_fee_bps, 1000)))
      when p_kind = 'poster_discount' then
        least(coalesce(p_discount_cents, 0),
              public.poster_discount_headroom(p_typical_gig_cents, 1000))
      else coalesce(p_bonus_cents, 0)
    end,
    'max_total_cents', case
      when p_kind = 'fee_override' then
        greatest(0, public.platform_fee_cents(p_typical_gig_cents, 1000)
                  - public.platform_fee_cents(p_typical_gig_cents, coalesce(p_fee_bps, 1000)))
        * greatest(1, coalesce(p_uses, 1)) * greatest(1, coalesce(p_redemptions, 1))
      when p_kind = 'poster_discount' then
        least(coalesce(p_discount_cents, 0),
              public.poster_discount_headroom(p_typical_gig_cents, 1000))
        * greatest(1, coalesce(p_redemptions, 1))
      else coalesce(p_bonus_cents, 0) * greatest(1, coalesce(p_redemptions, 1))
    end,
    'typical_gig_cents', p_typical_gig_cents,
    'note', 'Estimated on a typical gig. A fee waiver costs less than its headline '
            'because the processing floor is still collected.'
  )
$$;

revoke execute on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.estimate_campaign_cost(text, integer, integer, integer, integer, integer, integer)
  to authenticated, service_role;

-- ── A tier whose threshold duplicates another is unreachable ─────────────────
-- tier_fee_bps picks by `min_completed desc limit 1`, so two rungs at the same
-- threshold means one silently never applies. The unique index already prevents it;
-- this control catches a ladder that is nonsensical in the other direction — a HIGHER
-- threshold with a WORSE rate, which punishes loyalty and is always a typo.
create or replace function public.ctl_fee_tier_ladder_inverted()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select t2.id::text,
         jsonb_build_object(
           'tier', t2.name, 'min_completed', t2.min_completed, 'fee_bps', t2.fee_bps,
           'lower_tier', t1.name, 'lower_min', t1.min_completed, 'lower_fee_bps', t1.fee_bps,
           'note', 'this rung asks for MORE completed gigs but charges a HIGHER fee than '
                   'the one below it, so reaching it makes an earner worse off')
    from public.fee_tiers t1
    join public.fee_tiers t2
      on t2.min_completed > t1.min_completed and t2.fee_bps > t1.fee_bps
   where t1.enabled and t2.enabled
$$;

revoke execute on function public.ctl_fee_tier_ladder_inverted() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('fee_tier_ladder_inverted',
   'A loyalty rung charges more than a lower one',
   'medium', 'money',
   'tier_fee_bps takes the highest threshold the earner clears, so a rung that demands '
   'more gigs while charging a worse rate actively penalises the earners who did the '
   'most work. Always a typo, and invisible until someone crosses the threshold and '
   'their fee goes UP.',
   'ctl_fee_tier_ladder_inverted')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, fn_name = excluded.fn_name;
