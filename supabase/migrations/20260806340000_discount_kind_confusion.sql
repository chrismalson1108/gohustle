-- ─────────────────────────────────────────────────────────────────────────────
-- CRITICAL: an earner's fee-override was paid out as a poster discount.
--
-- My own regression, from the idempotence fix in 20260806240000 and carried into
-- 20260806320000.
--
-- promo_redemptions holds ONE ROW PER BOOKING, shared by both promotion kinds — that
-- single unique index IS the anti-stacking rule (20260806070000: "Stacking dies at two
-- unique indexes: one grant per user per promotion, one redemption per booking").
--
-- pin_booking_amount calls consume_promo_grant FIRST, which inserts that row for a
-- fee_override with reserved_cents = the EARNER's benefit. consume_poster_discount then
-- runs, and its "already priced" guard read the row without scoping it:
--
--     select r.reserved_cents into prior from promo_redemptions r
--      where r.booking_id = p_booking and r.released_at is null limit 1;
--     if found then return coalesce(prior, 0); end if;
--
-- No kind filter. No user filter — and p_user here is the POSTER while that row's
-- user_id is the EARNER. So the earner's fee-override reserve was returned as the
-- poster's discount.
--
-- Reproduced on production data, rolled back: a $100 gig, standing rate 1000 bps, an
-- earner holding the shipped "Win-back 5%" fee_override grant, a poster holding NOTHING,
-- and ZERO poster_discount campaigns in existence — bookings.poster_discount_cents came
-- out as 155.
--
-- What that costs: stripe-create-payment-intent charges the poster
-- authorizedCents = 10000 - 155 = 9845 and sets application_fee_amount = 500 - 155 = 345,
-- which is exactly the processing floor. Platform margin on the booking falls from 180c
-- to 25c. It fires on EVERY booking carrying a non-zero fee_override grant. Only a 0-bps
-- override escapes, because its headroom is zero.
--
-- Nothing caught it. ctl_poster_discount_underwater needs discount+credit > headroom and
-- 155 <= 155; ctl_discount_charged_not_delivered filters on kind='poster_discount' and
-- the row is fee_override; ctl_redemption_double_charge sees one increment and one row,
-- perfectly consistent. The in-function reconcile assertion passes too, because the fee
-- stays above zero. The money just quietly moved.
--
-- ── THE FIX IS NOT ONLY THE KIND FILTER ─────────────────────────────────────
--
-- Adding `and p2.kind = 'poster_discount'` to the guard is necessary and NOT sufficient.
-- With the guard scoped, the function proceeds to pick a grant and INSERT — and hits the
-- one-row-per-booking index against the fee_override row. That lands in the
-- `on conflict do nothing` branch, which ALSO read `prior` unscoped and returned the
-- same wrong number by a different route.
--
-- Both paths now return 0, which is the correct semantics rather than a patch: one
-- redemption per booking is the deliberate anti-stacking rule, so a booking that has
-- already consumed a fee override must not also consume a poster discount. Zero is the
-- honest answer — no discount was granted, no campaign was charged, and the poster pays
-- the full agreed amount.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.consume_poster_discount(
  p_user uuid, p_booking uuid, p_amount_cents integer, p_fee_bps integer,
  p_credit_cents integer default 0)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g   public.promo_grants%rowtype;
  p   public.promotions%rowtype;
  cap integer;
  hit integer;
  prior integer;
  taken boolean;
begin
  if p_user is null or p_booking is null then return 0; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return 0;
  end if;

  -- ALREADY PRICED AS A POSTER DISCOUNT — return exactly what was recorded, for this
  -- kind and this user. Scoping is the whole point: the row may belong to the EARNER's
  -- fee override, and returning its reserve here handed the poster a discount nobody
  -- granted and no campaign paid for.
  select r.reserved_cents into prior
    from public.promo_redemptions r
    join public.promotions p2 on p2.id = r.promotion_id
   where r.booking_id = p_booking
     and r.released_at is null
     and r.user_id = p_user
     and p2.kind = 'poster_discount'
   limit 1;
  if found then return coalesce(prior, 0); end if;

  -- THE SLOT IS TAKEN BY ANOTHER CAMPAIGN. One redemption per booking is the deliberate
  -- anti-stacking rule, so a booking that already consumed a fee override cannot also
  -- consume a poster discount. Stop here rather than computing a benefit that the insert
  -- below could never record.
  select exists (
    select 1 from public.promo_redemptions r
     where r.booking_id = p_booking and r.released_at is null
  ) into taken;
  if taken then return 0; end if;

  cap := greatest(0, public.poster_discount_headroom(p_amount_cents, p_fee_bps)
                     - greatest(0, coalesce(p_credit_cents, 0)));
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

  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (g.id, p.id, p_user, p_booking, coalesce(p_fee_bps, 1000), hit)
  on conflict (booking_id) do nothing;
  if not found then
    -- Lost the race, or another campaign already owns this booking's single redemption
    -- slot. Either way NOTHING was granted here, so return zero. Reading the existing
    -- row's reserved_cents was the second route to the same leak.
    return 0;
  end if;

  update public.promotions
     set redemptions_used = redemptions_used + 1,
         spent_cents      = spent_cents + hit
   where id = p.id
     and redemptions_used < max_redemptions
     and spent_cents + hit <= budget_cents;
  if not found then
    delete from public.promo_redemptions
     where booking_id = p_booking and promotion_id = p.id and grant_id = g.id;
    return 0;
  end if;

  update public.promo_grants set uses_consumed = uses_consumed + 1 where id = g.id;

  return hit;
end;
$$;

revoke execute on function public.consume_poster_discount(uuid, uuid, integer, integer, integer)
  from public, anon, authenticated;

-- ── The control that should have caught it ──────────────────────────────────
-- Every existing money control asked "is this discount too big?" or "does the campaign's
-- accounting balance?". None asked the simpler question: is there a discount at all that
-- nobody granted? That is the shape this bug had.
create or replace function public.ctl_discount_without_grant()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'poster_discount_cents', b.poster_discount_cents,
           'booking_status', b.status,
           'redemption_kind', (
             select p.kind from public.promo_redemptions r
              join public.promotions p on p.id = r.promotion_id
             where r.booking_id = b.id and r.released_at is null limit 1),
           'note', 'a poster discount was applied with no poster_discount redemption '
                   'behind it — money off the charge that no campaign paid for')
    from public.bookings b
   where coalesce(b.poster_discount_cents, 0) > 0
     and not exists (
       select 1 from public.promo_redemptions r
        join public.promotions p on p.id = r.promotion_id
       where r.booking_id = b.id
         and r.released_at is null
         and p.kind = 'poster_discount'
     )
$$;

revoke execute on function public.ctl_discount_without_grant() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('discount_without_grant',
   'A booking carries a poster discount with no poster-discount redemption behind it',
   'critical', 'money',
   'Every discount must trace to a campaign that was charged for it. One that does not '
   'is money off the poster''s charge that nobody granted and no budget funded — which '
   'is exactly what happened when consume_poster_discount read an earner''s fee-override '
   'redemption and returned it as the poster''s discount. The other money controls all '
   'asked whether a discount was too LARGE; none asked whether it should exist at all.',
   'ctl_discount_without_grant')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
