-- ─────────────────────────────────────────────────────────────────────────────
-- Referral bonuses: vest on outcome, deliver as fee credit (2026-08-06).
--
-- WHY VEST-ON-OUTCOME IS THE WHOLE DESIGN
--
-- The classic referral exploit — the one the owner personally farmed on another
-- platform — pays on an action the attacker controls alone (sign up, deposit). Free
-- accounts then make it an infinite loop, and no amount of per-account uniqueness
-- helps because accounts are free.
--
-- Here the bonus is created only when the REFERRED person completes a gig that reaches
-- 'verified', and becomes payable only after a refund window closes with no reversal.
-- To farm it you must do real work, find a real counterparty, and pay us a real fee on
-- both sides. The exploit stops being PROFITABLE, which is stronger than stopping it
-- being possible.
--
-- WHY CREDIT, NOT CASH
--
-- A fee credit is worth its face value to someone who works, costs us exactly that in
-- margin, and CANNOT EXCEED WHAT THEY WOULD HAVE PAID US — the loss ceiling is
-- structural rather than policed. Cash is worth face value to anyone, including
-- someone who never works again, and needs a platform balance, transfer-failure
-- handling and reconciliation. bonus_cash_payout_enabled stays OFF.
--
-- HOW A CREDIT REACHES A BOOKING
--
-- bookings.fee_credit_cents is pinned at INSERT alongside the amount and the rate, so
-- the fee stays derivable from IMMUTABLE inputs and capture remains idempotent under
-- retry — the property the whole pricing design rests on. The credit can never push
-- the fee below the processing floor, so a credit larger than the fee is consumed only
-- up to what it can actually offset and the remainder stays on the ledger for next
-- time. We never pay Stripe's costs out of pocket to honour a credit.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings
  add column if not exists fee_credit_cents integer not null default 0
    check (fee_credit_cents >= 0);

comment on column public.bookings.fee_credit_cents is
  'Bonus credit applied to this booking''s platform fee, frozen at INSERT. A third '
  'immutable input to the fee, so capture stays idempotent. Never lowers the fee '
  'below the processing floor.';

-- Fee after a credit. Separate from platform_fee_cents so the base arithmetic keeps
-- exactly one definition and this is visibly a second, additive step.
create or replace function public.platform_fee_after_credit(
  p_amount_cents integer, p_fee_bps integer, p_credit_cents integer
) returns integer
language sql
immutable
as $$
  select greatest(
    -- The floor is absolute: a credit reduces OUR margin, never Stripe's costs.
    ceil(coalesce(p_amount_cents, 0) * 0.029)::integer + 30 + 25,
    public.platform_fee_cents(p_amount_cents, p_fee_bps) - greatest(0, coalesce(p_credit_cents, 0))
  )
$$;

-- ── Vesting: create the bonus when the referred person's work is verified ────
create or replace function public.accrue_referral_bonus()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  referrer uuid;
  promo    public.promotions%rowtype;
begin
  if new.status <> 'verified' or coalesce(old.status, '') = 'verified' then
    return new;
  end if;

  -- Who referred the EARNER on this booking?
  select r.referrer_id into referrer
    from public.referrals r where r.referred_id = new.earner_id;
  if referrer is null or referrer = new.earner_id then
    return new;
  end if;

  -- An active bonus campaign, if any. No campaign = no bonus; this is not hardcoded.
  select * into promo from public.promotions
   where kind = 'bonus' and status = 'active'
     and starts_at <= now() and (ends_at is null or ends_at > now())
   order by created_at desc limit 1;
  if not found then return new; end if;

  -- Ceiling check as an increment, same discipline as fee promotions.
  update public.promotions
     set redemptions_used = redemptions_used + 1,
         spent_cents = spent_cents + promo.bonus_cents
   where id = promo.id
     and redemptions_used < max_redemptions
     and spent_cents + promo.bonus_cents <= budget_cents;
  if not found then return new; end if;

  -- PENDING until the refund window closes. The unique index makes a re-fired
  -- trigger or a replayed webhook a no-op rather than a second bonus.
  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state,
     source_booking_id, source_user_id, vests_at)
  values (referrer, promo.id, 'referral', promo.bonus_cents, promo.bonus_delivery,
          'pending', new.id, new.earner_id, now() + interval '7 days')
  on conflict do nothing;

  return new;
exception when others then
  -- A bonus bug must never block a verification, which is what releases the
  -- earner's money.
  raise warning 'referral bonus accrual failed for booking %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke execute on function public.accrue_referral_bonus() from public, anon, authenticated;

drop trigger if exists trg_z_accrue_referral_bonus on public.bookings;
create trigger trg_z_accrue_referral_bonus
  after update of status on public.bookings
  for each row execute function public.accrue_referral_bonus();

-- ── Vesting sweep: pending -> payable, or void ───────────────────────────────
-- Run from the hourly control sweep. Anything whose source booking was refunded or
-- disputed is voided rather than paid: the referral was not, in the end, successful.
create or replace function public.vest_bonuses()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.bonus_ledger b
     set state = 'void',
         void_reason = 'source booking was reversed or disputed'
   where b.state = 'pending'
     and exists (
       select 1 from public.payments p
        where p.booking_id = b.source_booking_id
          and (coalesce(p.refunded_cents, 0) > 0 or p.status = 'refunded')
     );

  update public.bonus_ledger b
     set state = 'payable'
   where b.state = 'pending'
     and b.vests_at <= now()
     and not exists (
       select 1 from public.disputes d where d.booking_id = b.source_booking_id
         and coalesce(d.status, 'open') in ('open', 'investigating')
     );
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.vest_bonuses() from public, anon, authenticated;
grant  execute on function public.vest_bonuses() to service_role;

-- ── Spend a payable credit at booking time ───────────────────────────────────
create or replace function public.consume_fee_credit(
  p_user uuid, p_booking uuid, p_amount_cents integer, p_fee_bps integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  headroom integer;
  taken    integer := 0;
  r        record;
begin
  if p_user is null then return 0; end if;

  -- Only what the credit can actually offset: the gap between the fee and the floor.
  -- Anything beyond that would mean paying Stripe's processing out of pocket.
  headroom := greatest(0,
      public.platform_fee_cents(p_amount_cents, p_fee_bps)
    - (ceil(coalesce(p_amount_cents, 0) * 0.029)::integer + 30 + 25));
  if headroom <= 0 then return 0; end if;

  for r in
    select id, amount_cents from public.bonus_ledger
     where user_id = p_user and state = 'payable' and delivery = 'credit'
     order by created_at asc
     for update
  loop
    exit when taken >= headroom;
    if r.amount_cents <= headroom - taken then
      update public.bonus_ledger
         set state = 'applied', applied_at = now(), applied_booking_id = p_booking
       where id = r.id;
      taken := taken + r.amount_cents;
    else
      -- Partially usable: spend what fits, leave the rest on the ledger. Splitting
      -- rather than forfeiting is the difference between a credit and a coupon.
      update public.bonus_ledger set amount_cents = amount_cents - (headroom - taken) where id = r.id;
      insert into public.bonus_ledger
        (user_id, promotion_id, reason, amount_cents, delivery, state, applied_at, applied_booking_id, source_booking_id)
      select user_id, promotion_id, reason, headroom - taken, delivery, 'applied', now(), p_booking, null
        from public.bonus_ledger where id = r.id;
      taken := headroom;
    end if;
  end loop;

  return taken;
end;
$$;

revoke execute on function public.consume_fee_credit(uuid, uuid, integer, integer)
  from public, anon, authenticated;

-- ── Wire the credit into the pin ─────────────────────────────────────────────
-- Full reproduction again (create or replace needs the whole body). Order matters:
-- resolve the RATE first (standing rate, then any promotion), because how much credit
-- is usable depends on how big the fee is.
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
    select pay, pay_type, estimated_hours into j
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

    -- Credit is applied AFTER the rate is final, since usable headroom depends on it.
    begin
      new.fee_credit_cents := coalesce(public.consume_fee_credit(
        new.earner_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted), 0);
    exception when others then
      new.fee_credit_cents := 0;
      raise warning 'fee credit application failed for booking %: %', new.id, sqlerrm;
    end;

    return new;
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.amount_cents_quoted := old.amount_cents_quoted;
    new.fee_bps_quoted      := old.fee_bps_quoted;
    new.fee_credit_cents    := old.fee_credit_cents;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_booking_amount() from public, anon, authenticated;

-- Carry the credit onto the payment so capture and claim derive from it too.
alter table public.payments
  add column if not exists fee_credit_cents integer not null default 0
    check (fee_credit_cents >= 0);

create or replace function public.pin_payment_fee_bps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    select coalesce(b.fee_bps_quoted, 1000), coalesce(b.fee_credit_cents, 0)
      into new.fee_bps, new.fee_credit_cents
      from public.bookings b where b.id = new.booking_id;
    new.fee_bps := coalesce(new.fee_bps, 1000);
    new.fee_credit_cents := coalesce(new.fee_credit_cents, 0);
  else
    new.fee_bps := old.fee_bps;
    new.fee_credit_cents := old.fee_credit_cents;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_payment_fee_bps() from public, anon, authenticated;

-- Vesting runs as a control so it inherits the sweep's scheduling and alerting
-- rather than needing its own cron entry.
create or replace function public.ctl_bonus_vesting_stalled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'user_id', b.user_id, 'amount_cents', b.amount_cents,
           'vests_at', b.vests_at, 'state', b.state,
           'days_overdue', round(extract(epoch from now() - b.vests_at) / 86400)::int)
    from public.bonus_ledger b
   where b.state = 'pending'
     and b.vests_at < now() - interval '2 days'
$$;

revoke execute on function public.ctl_bonus_vesting_stalled() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('bonus_vesting_stalled',
   'Referral bonus past its vesting date and still pending',
   'medium', 'money',
   'vest_bonuses() flips pending -> payable once the refund window closes. A bonus '
   'sitting pending well past vests_at means the sweep is not running or is erroring, '
   'so people who earned a referral reward are silently not getting it.',
   'ctl_bonus_vesting_stalled')
on conflict (key) do update set title = excluded.title, why = excluded.why;

-- Run vesting at the top of every sweep, before the controls read the ledger.
create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg jsonb; on_ boolean; url text; secret text;
begin
  -- Vesting first: the bonus_vesting_stalled control should judge the state AFTER
  -- this sweep's vesting ran, not before, or it reports work it was about to do.
  begin
    perform public.vest_bonuses();
  exception when others then
    raise warning 'bonus vesting failed: %', sqlerrm;
  end;

  perform public.run_all_controls();

  cfg    := public.alert_config('controls_alert');
  on_    := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    := nullif(cfg->>'url', '');
  secret := coalesce(cfg->>'secret', '');
  if not on_ or url is null then return; end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'page', 'since_minutes', 90)
    );
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.controls_sweep_and_page() from public, anon, authenticated;
grant execute on function public.controls_sweep_and_page() to service_role;
