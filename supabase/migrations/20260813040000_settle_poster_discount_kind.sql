-- ─────────────────────────────────────────────────────────────────────────────
-- A poster-discount campaign refunds itself at capture, so its budget never binds.
--
-- `settle_booking_benefits` re-prices every redemption at capture using ONE formula:
--
--     actual := least(max_benefit_cents, promo_benefit_cents(amount, r.fee_bps))
--
-- `promo_benefit_cents` computes a FEE-OVERRIDE saving — the gap between the standing
-- rate and the promo rate. That is right for `kind = 'fee_override'` and meaningless
-- for `kind = 'poster_discount'`, whose cost is the discount itself and has nothing to
-- do with fees.
--
-- Worse than meaningless, it evaluates to ZERO. `consume_poster_discount` stores
-- `fee_bps = coalesce(p_fee_bps, 1000)` — the booking's ORDINARY rate, kept for the
-- audit trail. Feeding the standing rate into a "how much cheaper than standing" helper
-- returns 0 by definition. So:
--
--     actual := least(max_benefit_cents, 0)      = 0
--     delta  := 0 - reserved_cents               = -(the whole discount)
--     spent_cents := spent_cents + delta         → back to where it started
--
-- Every poster discount is charged to the campaign at booking and REFUNDED to it at
-- capture. `budget_cents` and `max_redemptions` are checked against a number that
-- returns to zero after every settled booking, so a campaign can give away without
-- limit while `/promotions` shows the burn-down bar near empty. The one bound the
-- incentive layer is documented to rest on — "loss is bounded by construction" — does
-- not hold for this kind.
--
-- DORMANT TODAY, and that is the only reason this is a migration rather than an
-- incident: 1 promotion row, 0 codes, 0 grants, 0 redemptions. Nothing has been given
-- away yet. Found by the read-only payments audit of 2026-08-12; the mechanism above
-- was re-derived here from the live pg_proc bodies before anything was changed.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- Settle PER KIND, because the kinds do not share a cost model:
--   fee_override    → promo_benefit_cents(amount, fee_bps)   (unchanged, correct)
--   poster_discount → what was actually taken off the poster's charge
--   bonus           → not settled here at all; bonuses vest through bonus_ledger
--
-- For a poster discount the authoritative figure is `payments.poster_discount_cents`,
-- pinned at booking by trg_z_pin_payment_fee_bps and therefore immutable — the same
-- property capture idempotency already depends on. `reserved_cents` is the fallback.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.settle_booking_benefits(p_booking uuid, p_amount_cents integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r        public.promo_redemptions%rowtype;
  k        text;
  cap      int;
  actual   int;
  delta    int;
  n        int := 0;
begin
  if p_booking is null or p_amount_cents is null then return 0; end if;

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
      -- fee_override (and anything else that prices off the fee gap).
      actual := public.promo_benefit_cents(p_amount_cents, r.fee_bps);
    end if;

    -- The campaign's per-use ceiling still applies to what it is CHARGED.
    actual := least(coalesce(cap, r.reserved_cents), actual);

    delta := actual - r.reserved_cents;

    -- Only ever RELAX the budget here (delta is normally negative — the reserve was the
    -- worst case). A positive delta is possible if the standing rate rose between
    -- booking and capture; allow it, because the money genuinely was spent, but the
    -- campaign's own ceiling still bounds it.
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

-- ── A campaign that has given away more than it was charged ─────────────────
-- The invariant this bug broke, asserted directly against data rather than against a
-- function body: what a campaign has been charged must not fall below what its settled
-- redemptions actually delivered.
create or replace function public.ctl_promo_spend_understated()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'name', p.name,
           'kind', p.kind,
           'spent_cents', p.spent_cents,
           'delivered_cents', d.delivered,
           'budget_cents', p.budget_cents,
           'note', 'this campaign has delivered more benefit than it has been charged '
                   '— its budget is not bounding what it gives away')
    from public.promotions p
    join lateral (
      select coalesce(sum(r.benefit_cents), 0) delivered
        from public.promo_redemptions r
       where r.promotion_id = p.id and r.settled and r.released_at is null
    ) d on true
   where d.delivered > p.spent_cents + 100     -- $1 of slack for rounding
$$;

revoke execute on function public.ctl_promo_spend_understated() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('promo_spend_understated',
   'A campaign has given away more than its budget was charged',
   'high', 'money',
   'The incentive layer is documented as bounded by budget_cents. That only holds if '
   'spent_cents reflects what was actually delivered. settle_booking_benefits priced '
   'poster discounts with the fee-override formula, which returns zero for them, so '
   'every discount was refunded to its own campaign at capture and the budget never '
   'bound. This asserts the invariant against data rather than trusting the formula.',
   'ctl_promo_spend_understated')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
