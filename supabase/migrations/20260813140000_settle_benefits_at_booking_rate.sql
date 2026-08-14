-- ─────────────────────────────────────────────────────────────────────────────
-- A campaign's spend was re-priced by a rate change it had nothing to do with.
--
-- settle_booking_benefits charges a fee_override campaign what the benefit was WORTH:
-- the gap between the fee the booking would have paid and the fee it actually paid. That
-- gap is computed by promo_benefit_cents, which reads
--
--     public.fee_bps_at(now())
--
-- — the STANDING RATE AT CAPTURE. The counterfactual it needs is the rate that applied
-- when the booking was MADE.
--
-- This repo already treats that distinction as load-bearing everywhere else. CLAUDE.md:
-- "A rate change never re-prices an existing booking", enforced by pinning four immutable
-- inputs at INSERT. The standing rate moved from 1000 to 700 bps on 2026-08-12, so any
-- booking made before that and captured after has its campaign charged against a 7%
-- baseline it never had.
--
-- Direction of the error: the rate FELL, so the counterfactual fee is smaller, so the
-- measured benefit is smaller, so campaigns are UNDER-charged and their budgets last
-- longer than the money they actually gave away. A rate rise inverts it and exhausts a
-- campaign early. Either way the number is not what happened.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- fee_bps_at() already takes a timestamp — it is an effective-dated rate card and this is
-- exactly what that parameter is for. It was simply being passed now(). Price the
-- counterfactual at the BOOKING's creation time instead.
--
-- promo_benefit_cents keeps its two-argument form (other callers exist) and gains an
-- optional `p_at`, defaulting to now() so nothing else changes behaviour.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the 2-arg form first. Adding a 3-arg overload WITH a default alongside it makes
-- `promo_benefit_cents(int, int)` ambiguous — Postgres cannot choose between the exact
-- 2-arg match and the 3-arg default, and every existing caller starts erroring with
-- "function is not unique". The defaulted 3-arg form covers those callers identically.
drop function if exists public.promo_benefit_cents(integer, integer);

create or replace function public.promo_benefit_cents(
  p_amount_cents integer,
  p_fee_bps      integer,
  p_at           timestamptz default now()
) returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(0,
    public.platform_fee_cents(p_amount_cents, public.fee_bps_at(p_at))
  - public.platform_fee_cents(p_amount_cents, p_fee_bps))
$$;

revoke execute on function public.promo_benefit_cents(integer, integer, timestamptz) from public, anon;

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
      -- The cost IS the discount. Read what was actually taken off the poster's
      -- charge; that column is pinned at booking and cannot drift.
      actual := coalesce(
        (select poster_discount_cents from public.payments
          where booking_id = p_booking and coalesce(poster_discount_cents, 0) > 0
          order by created_at desc limit 1),
        r.reserved_cents);
    else
      -- fee_override. Priced at the BOOKING's rate, not today's — see the header.
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

-- ── Prove the counterfactual now follows the booking, not the clock ─────────
do $$
declare
  at_old timestamptz := '2026-08-01'::timestamptz;   -- standing rate was 1000 bps
  at_now timestamptz := now();                        -- standing rate is 700 bps
  b_old int; b_now int;
begin
  -- A 0-bps override on a $100 gig: the benefit is the whole fee the booking would
  -- otherwise have paid, so it moves with the baseline rate.
  b_old := public.promo_benefit_cents(10000, 0, at_old);
  b_now := public.promo_benefit_cents(10000, 0, at_now);

  if b_old = b_now then
    raise notice 'rate card is flat across these dates; the probe cannot discriminate (b=%)', b_old;
  else
    raise notice 'benefit at booking-time rate = % cents; at today rate = % cents — that gap is what campaigns were mis-charged', b_old, b_now;
  end if;

  -- The two-argument form must still work for existing callers.
  if public.promo_benefit_cents(10000, 0) <> b_now then
    raise exception 'the 2-arg overload changed behaviour';
  end if;
  raise notice '2-arg form unchanged';
end $$;
