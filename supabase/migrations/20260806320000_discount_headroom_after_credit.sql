-- ─────────────────────────────────────────────────────────────────────────────
-- A poster discount could be charged in full and delivered as zero.
--
-- pin_booking_amount applies benefits in order: promo rate, then fee credit, then
-- poster discount. Both the credit and the discount are funded out of the SAME pot —
-- the headroom between the platform fee and the Stripe processing floor — because
-- neither may push the platform into paying processing out of pocket.
--
-- consume_poster_discount computes that headroom from scratch:
--
--     cap := poster_discount_headroom(p_amount_cents, p_fee_bps);
--
-- and knows nothing about the credit that consume_fee_credit just spent out of it. So
-- it charges the campaign, burns one of the poster's grant uses, and returns a discount.
-- Only afterwards does the pin clamp the STORED value:
--
--     new.poster_discount_cents := least(consumed, greatest(0, headroom - fee_credit_cents));
--
-- On a booking where the credit already took the headroom, that clamp is zero. The
-- campaign has been charged, the poster's use is gone, and the poster receives NOTHING.
--
-- Worked example on a $100 gig at 10%: fee 1000c, floor 345c, headroom 655c. An earner
-- fee credit consumes all 655. A 500c poster-discount campaign then charges itself 500,
-- burns a use, and the pin clamps the delivered discount to 0.
--
-- Same family as the other benefit bugs fixed today — a charge recorded against a
-- benefit that was never delivered — and the same fix: decide before charging, never
-- after. The function now receives the credit already spent and subtracts it from the
-- headroom BEFORE choosing a grant, so a discount that cannot be delivered is never
-- charged and no use is burned.
--
-- The pin's own clamp is deliberately KEPT. It should now never bind, which is exactly
-- why it is worth keeping: if it ever does, the two calculations have drifted and the
-- clamp is the thing standing between that and a negative application_fee_amount.
--
-- Reproduced from the LIVE pg_proc body, which already carries the idempotence fix
-- from 20260806240000 (early return on an existing redemption, insert-before-charge,
-- scoped rollback). Only the cap changes.
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
begin
  if p_user is null or p_booking is null then return 0; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return 0;
  end if;

  -- ALREADY PRICED. Return what was recorded and touch nothing. This must come before
  -- any increment: the increments used to run first and `on conflict do nothing` hid
  -- the duplicate, so the campaign paid twice for one booking.
  select r.reserved_cents into prior
    from public.promo_redemptions r
   where r.booking_id = p_booking
     and r.released_at is null
   limit 1;
  if found then return coalesce(prior, 0); end if;

  -- THE HEADROOM MINUS WHAT THE FEE CREDIT ALREADY TOOK. The credit and the discount
  -- are funded from the same gap between the fee and the processing floor. Computing
  -- this without the credit meant charging a campaign for a discount the pin would then
  -- clamp to zero — paid for, never delivered, and a grant use burned for nothing.
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

  -- Insert FIRST, so the unique index on booking_id is the thing that arbitrates a
  -- race. If a concurrent call already claimed this booking, we lose the insert and
  -- must not charge anything.
  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (g.id, p.id, p_user, p_booking, coalesce(p_fee_bps, 1000), hit)
  on conflict (booking_id) do nothing;
  if not found then
    select r.reserved_cents into prior
      from public.promo_redemptions r where r.booking_id = p_booking limit 1;
    return coalesce(prior, 0);
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

-- The 4-argument version is gone: leaving it would let a caller silently get the old,
-- credit-blind behaviour, which is the bug.
drop function if exists public.consume_poster_discount(uuid, uuid, integer, integer);

-- ── Pass the credit through ─────────────────────────────────────────────────
-- Reproduced from the live pin with one changed call. Everything else — the tier and
-- promo lowest-wins ordering, the per-benefit exception handlers, the UPDATE branch
-- that pins all four columns against non-service_role writes — is unchanged.
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
    begin
      promoBps := public.consume_promo_grant(new.earner_id, new.id, new.amount_cents_quoted);
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
create or replace function public.ctl_discount_charged_not_delivered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.booking_id::text,
         jsonb_build_object(
           'promotion_id', r.promotion_id,
           'charged_cents', r.reserved_cents,
           'delivered_cents', coalesce(b.poster_discount_cents, 0),
           'fee_credit_cents', coalesce(b.fee_credit_cents, 0),
           'booking_status', b.status)
    from public.promo_redemptions r
    join public.bookings b on b.id = r.booking_id
    join public.promotions p on p.id = r.promotion_id
   where p.kind = 'poster_discount'
     and r.released_at is null
     and r.reserved_cents > coalesce(b.poster_discount_cents, 0)
$$;

revoke execute on function public.ctl_discount_charged_not_delivered() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('discount_charged_not_delivered',
   'A poster-discount campaign was charged more than the booking actually received',
   'high', 'money',
   'The fee credit and the poster discount are funded from the same headroom between '
   'the platform fee and the Stripe processing floor. If the discount is sized without '
   'accounting for the credit, the campaign is charged and a grant use burned for a '
   'benefit the pin then clamps to zero — the poster pays full price while the campaign '
   'books the spend.',
   'ctl_discount_charged_not_delivered')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
