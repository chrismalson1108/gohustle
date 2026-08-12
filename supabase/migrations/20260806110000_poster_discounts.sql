-- ─────────────────────────────────────────────────────────────────────────────
-- Poster-side discounts: the missing half of the incentive system (2026-08-06).
--
-- WHY THIS IS A SEPARATE MECHANISM
--
-- The platform fee comes out of the EARNER's payout (earnerAmountCents = amountCents -
-- feeCents). So a fee override is a SUPPLY-side incentive — it makes an earner keep
-- more and does nothing whatsoever for the poster, who still pays the full gig price.
-- Every promotion built so far only reaches one side of a two-sided marketplace.
--
-- A poster discount reduces what the POSTER IS CHARGED while the earner still receives
-- their full agreed pay. The platform absorbs the difference, which is what the owner
-- chose: earners must never take a surprise pay cut to fund our marketing.
--
--   normal:    poster pays P        earner gets P - fee     platform keeps fee
--   discount:  poster pays P - D    earner gets P - fee     platform keeps fee - D
--
-- CAPPED AT THE TAKE RATE, DELIBERATELY. If D ever exceeded (fee - floor) the platform
-- fee would go negative, and Stripe's application_fee_amount CANNOT be negative — the
-- platform would have to fund the gap with a separate transfer off its own balance,
-- which means balance monitoring, transfer-failure handling, and a whole new class of
-- outage. Capping at the available headroom keeps this to arithmetic on a field we
-- already send. If a campaign ever genuinely needs more, that is a deliberate decision
-- to build the transfer path, not something a form should be able to trigger.
--
-- The discount is PINNED at booking like everything else, so the poster is charged
-- exactly what they were quoted and a campaign ending cannot re-price an accepted job.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.promotions
  add column if not exists poster_discount_cents integer
    check (poster_discount_cents is null or poster_discount_cents between 0 and 50000);

-- The kind vocabulary grows by one. Rewritten rather than added to because a CHECK
-- cannot be extended in place.
alter table public.promotions drop constraint if exists promotions_kind_check;
alter table public.promotions
  add constraint promotions_kind_check
  check (kind in ('fee_override', 'bonus', 'poster_discount'));

alter table public.promotions drop constraint if exists promotions_kind_shape;
alter table public.promotions
  add constraint promotions_kind_shape check (
    (kind = 'fee_override'    and fee_bps is not null and bonus_cents is null) or
    (kind = 'bonus'           and bonus_cents is not null and fee_bps is null) or
    (kind = 'poster_discount' and poster_discount_cents is not null
                              and fee_bps is null and bonus_cents is null)
  );

alter table public.bookings
  add column if not exists poster_discount_cents integer not null default 0
    check (poster_discount_cents >= 0);
alter table public.payments
  add column if not exists poster_discount_cents integer not null default 0
    check (poster_discount_cents >= 0);

comment on column public.bookings.poster_discount_cents is
  'Reduction in what the POSTER is charged, frozen at INSERT. The earner still receives '
  'their full agreed pay; the platform absorbs this out of its fee. Capped at the '
  'headroom between the fee and the processing floor, so the platform fee can never go '
  'negative — Stripe cannot express that.';

-- What the poster is actually charged.
create or replace function public.poster_charge_cents(
  p_amount_cents integer, p_discount_cents integer
) returns integer
language sql
immutable
as $$
  select greatest(50, coalesce(p_amount_cents, 0) - greatest(0, coalesce(p_discount_cents, 0)))
$$;

-- How much discount is actually fundable out of our own margin on this booking.
create or replace function public.poster_discount_headroom(
  p_amount_cents integer, p_fee_bps integer
) returns integer
language sql
immutable
as $$
  select greatest(0,
      public.platform_fee_cents(p_amount_cents, p_fee_bps)
    - (ceil(coalesce(p_amount_cents, 0) * 0.029)::integer + 30 + 25))
$$;

-- Claim a poster discount for this booking. Mirrors consume_promo_grant: same
-- increment-is-the-check ceiling discipline, same snapshot-on-the-grant rule.
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

  -- Never more than we can fund from our own margin on THIS booking.
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

-- ── Pin it, alongside everything else ────────────────────────────────────────
-- Note the grant is looked up against the JOB'S POSTER, not the earner: this is the
-- one benefit whose beneficiary is the other party to the booking.
create or replace function public.pin_booking_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j        record;
  promoBps integer;
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

    -- Poster discount last: its ceiling depends on the fee, which the two steps above
    -- may already have reduced. Taking it earlier could promise a discount the
    -- remaining margin cannot fund.
    begin
      new.poster_discount_cents := coalesce(public.consume_poster_discount(
        j.poster_id, new.id, new.amount_cents_quoted,
        new.fee_bps_quoted), 0);
      -- Everything already committed to the earner comes out of the same margin, so
      -- the discount can only have what is left after the credit.
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

create or replace function public.pin_payment_fee_bps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    select coalesce(b.fee_bps_quoted, 1000), coalesce(b.fee_credit_cents, 0),
           coalesce(b.poster_discount_cents, 0)
      into new.fee_bps, new.fee_credit_cents, new.poster_discount_cents
      from public.bookings b where b.id = new.booking_id;
    new.fee_bps := coalesce(new.fee_bps, 1000);
    new.fee_credit_cents := coalesce(new.fee_credit_cents, 0);
    new.poster_discount_cents := coalesce(new.poster_discount_cents, 0);
  else
    new.fee_bps := old.fee_bps;
    new.fee_credit_cents := old.fee_credit_cents;
    new.poster_discount_cents := old.poster_discount_cents;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_payment_fee_bps() from public, anon, authenticated;

-- A control, because this is the one promotion that can make the platform fee go
-- negative if the caps are ever wrong — and a negative application_fee_amount is not
-- something Stripe will tell us about politely.
create or replace function public.ctl_poster_discount_underwater()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'amount_cents', b.amount_cents_quoted,
           'fee_bps', b.fee_bps_quoted,
           'poster_discount_cents', b.poster_discount_cents,
           'fee_credit_cents', b.fee_credit_cents,
           'computed_fee', public.platform_fee_cents(b.amount_cents_quoted, b.fee_bps_quoted),
           'headroom', public.poster_discount_headroom(b.amount_cents_quoted, b.fee_bps_quoted))
    from public.bookings b
   where coalesce(b.poster_discount_cents, 0) + coalesce(b.fee_credit_cents, 0)
         > public.poster_discount_headroom(b.amount_cents_quoted, b.fee_bps_quoted)
$$;

revoke execute on function public.ctl_poster_discount_underwater() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('poster_discount_underwater',
   'Booking where discounts exceed the margin available to fund them',
   'critical', 'money',
   'A poster discount plus a fee credit that together exceed the headroom between the '
   'platform fee and the processing floor would drive application_fee_amount negative, '
   'which Stripe cannot represent — the capture would fail, or worse, succeed with the '
   'platform funding Stripe''s costs. Both are capped at write time; this catches a cap '
   'that was wrong.',
   'ctl_poster_discount_underwater')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, fn_name = excluded.fn_name;
