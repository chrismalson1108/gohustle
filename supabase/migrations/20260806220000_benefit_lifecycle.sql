-- ─────────────────────────────────────────────────────────────────────────────
-- The benefit lifecycle was one-way: consume, and never anything else.
--
-- Three defects, all in the same seam, found by the adversarial audit.
--
-- ── 1. A DECLINED BOOKING BURNED THE BENEFIT FOREVER ────────────────────────
--
-- consume_promo_grant runs from pin_booking_amount — at INSERT, when the earner
-- applies. The poster then declines, or either party cancels. Nothing gives the
-- benefit back: uses_consumed stays incremented, the campaign stays charged, and the
-- user has spent one of their "first 2 gigs free" on a gig that never happened and
-- for which no money ever moved.
--
-- That is the exact shape of complaint that makes an incentive feel rigged, and it is
-- worse than it first looks: a poster who declines applications — for any reason, or
-- none — silently drains the promo allowance of every earner who applied.
--
-- ── 2. reserved_cents WAS WRITTEN FOUR TIMES AND READ ZERO TIMES ────────────
--
-- The design was explicit and correct: charge the campaign the WORST case at booking
-- so in-flight work cannot oversubscribe the budget, then settle to the real figure at
-- capture. The settle half was never built. Every campaign is therefore permanently
-- charged max_benefit_cents per redemption regardless of the actual gig value, so a
-- budget bounds far less real discount than intended and campaigns exhaust early.
-- benefit_cents — the column meant to hold the true cost — is always 0.
--
-- ── 3. THE BUDGET COUNTERFACTUAL HARDCODED 1000 bps ─────────────────────────
--
-- hit := platform_fee_cents(amount, 1000) - platform_fee_cents(amount, g.fee_bps)
--
-- "What this discount costs" is measured against a literal 10%, but the standing rate
-- is configurable (fee_bps_at, 20260806050000) precisely so it can change. Raise the
-- platform rate to 15% and every 0%-fee promo actually costs 15% while the budget is
-- charged 10% — a 50% undercount, in the unsafe direction, silently. The counterfactual
-- has to be whatever the user WOULD have paid, which is the standing rate.
--
-- ── WHAT RELEASE MUST NOT DO ────────────────────────────────────────────────
--
-- Releasing a benefit whose money already moved would hand back a discount the platform
-- already ate. So release refuses when a payment for that booking has been captured,
-- and it is idempotent — a redemption already released or settled is left alone. Both
-- are enforced in SQL rather than by trusting the caller, because the caller is a
-- lifecycle trigger that fires on every status change.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Redemption state ────────────────────────────────────────────────────────
-- Additive. The existing `settled` boolean stays and stays in sync, so anything already
-- reading it keeps working.
alter table public.promo_redemptions
  add column if not exists released_at timestamptz,
  add column if not exists settled_at  timestamptz,
  add column if not exists release_reason text;

-- THE INDEX STAYS PLAIN. An earlier version of this migration made it partial
-- (`where released_at is null`) on the reasoning that a released redemption should not
-- block a re-book of the same booking. That was wrong twice over:
--
--   1. It broke a live path immediately. consume_poster_discount inserts with
--      `on conflict (booking_id) do nothing`, and ON CONFLICT inference CANNOT match a
--      partial index — every poster-discount consumption began failing with 42P10.
--   2. The scenario it protected against cannot occur: booking ids are never reused,
--      and a released redemption belongs to a declined or cancelled booking, which is
--      terminal.
--
-- So it bought nothing and cost a production regression. Any future change here must
-- keep the index inferrable by a bare `on conflict (booking_id)`.
create unique index if not exists promo_redemptions_one_per_booking
  on public.promo_redemptions (booking_id);

-- ── The standing-rate counterfactual ────────────────────────────────────────
-- What the user would have paid absent any promo, at the rate in force right now.
create or replace function public.promo_benefit_cents(p_amount_cents integer, p_fee_bps integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(0,
    public.platform_fee_cents(p_amount_cents, public.fee_bps_at(now()))
  - public.platform_fee_cents(p_amount_cents, p_fee_bps))
$$;

revoke execute on function public.promo_benefit_cents(integer, integer) from public, anon, authenticated;

-- ── Release ─────────────────────────────────────────────────────────────────
create or replace function public.release_booking_benefits(p_booking uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r        public.promo_redemptions%rowtype;
  released int := 0;
  captured boolean;
begin
  if p_booking is null then return 0; end if;

  -- Never claw back a benefit whose money already moved. Tested on captured_at as well
  -- as status: status is an enum that has gained values before, and the timestamp is the
  -- fact. A partial capture writes both, so it is covered.
  select exists (
    select 1 from public.payments pay
     where pay.booking_id = p_booking
       and (pay.status = 'captured' or pay.captured_at is not null)
  ) into captured;
  if captured then return 0; end if;

  for r in
    select * from public.promo_redemptions
     where booking_id = p_booking
       and released_at is null
       and settled_at is null
     for update
  loop
    -- Give the campaign back what it reserved, and the user back their use.
    update public.promotions
       set redemptions_used = greatest(0, redemptions_used - 1),
           spent_cents      = greatest(0, spent_cents - r.reserved_cents)
     where id = r.promotion_id;

    update public.promo_grants
       set uses_consumed = greatest(0, uses_consumed - 1)
     where id = r.grant_id;

    update public.promo_redemptions
       set released_at = now(), release_reason = p_reason
     where id = r.id;

    released := released + 1;
  end loop;

  -- DELIBERATELY DOES NOT TOUCH bookings.fee_credit_cents / poster_discount_cents.
  --
  -- An earlier draft cleared them here and it was a serious mistake, caught in
  -- simulation: this function runs from an AFTER UPDATE trigger on bookings, so that
  -- write re-entered guard_bookings_write, which rejects it for most callers — and an
  -- exception raised in an AFTER trigger ROLLS BACK THE STATEMENT THAT FIRED IT. A
  -- poster tapping "decline" would have got "not authorized to modify this booking"
  -- and the decline would have failed.
  --
  -- It was also pointless: a declined or cancelled booking never reaches a payment
  -- intent, so the pins are inert. Leaving them is strictly better — they record what
  -- the benefit WOULD have been, which is the only evidence of why a use was returned.
  return released;
end;
$$;

revoke execute on function public.release_booking_benefits(uuid, text) from public, anon, authenticated;

-- ── Settle ──────────────────────────────────────────────────────────────────
-- Called at capture, when the real captured amount is finally known. Adjusts the
-- campaign by the DELTA between what was reserved and what the benefit actually cost.
create or replace function public.settle_booking_benefits(p_booking uuid, p_amount_cents integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r      public.promo_redemptions%rowtype;
  actual int;
  delta  int;
  n      int := 0;
begin
  if p_booking is null or p_amount_cents is null then return 0; end if;

  for r in
    select * from public.promo_redemptions
     where booking_id = p_booking
       and released_at is null
       and settled_at is null
     for update
  loop
    -- The true cost of this benefit, never more than the campaign's per-use cap.
    actual := least(
      coalesce((select max_benefit_cents from public.promotions where id = r.promotion_id),
               r.reserved_cents),
      public.promo_benefit_cents(p_amount_cents, r.fee_bps));

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

-- ── Fire release on the lifecycle ───────────────────────────────────────────
create or replace function public.trg_release_benefits_on_dead_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('declined', 'cancelled')
     and coalesce(old.status, '') is distinct from new.status then
    perform public.release_booking_benefits(new.id, 'booking_' || new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zz_release_benefits on public.bookings;
create trigger trg_zz_release_benefits
  after update of status on public.bookings
  for each row execute function public.trg_release_benefits_on_dead_booking();

-- ── Correct the counterfactual at the source ────────────────────────────────
-- REPRODUCED FROM THE LIVE pg_proc BODY, not from an earlier migration file. The file
-- this function was first defined in is three revisions stale: the live version has
-- since gained the promotions_enabled kill switch, the revoked_at check, and the
-- kind='fee_override' filter. Replacing it from the original text would have silently
-- reverted all three. The ONLY change below is the counterfactual.
create or replace function public.consume_promo_grant(
  p_user uuid, p_booking uuid, p_amount_cents integer)
returns integer
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

  -- The worst case cost of this use, measured against the rate the user would
  -- OTHERWISE have paid. Settled to the real figure at capture.
  hit := least(p.max_benefit_cents, public.promo_benefit_cents(p_amount_cents, g.fee_bps));

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

-- ── A control, because a lifecycle bug is invisible without one ─────────────
create or replace function public.ctl_benefit_never_settled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.booking_id::text,
         jsonb_build_object(
           'promotion_id', r.promotion_id,
           'reserved_cents', r.reserved_cents,
           'booking_status', b.status,
           'captured_at', pay.captured_at,
           'age_hours', round(extract(epoch from now() - r.created_at) / 3600.0, 1))
    from public.promo_redemptions r
    join public.bookings b on b.id = r.booking_id
    left join public.payments pay on pay.booking_id = r.booking_id
   where r.released_at is null
     and r.settled_at is null
     and b.status in ('verified', 'declined', 'cancelled')
     and r.created_at < now() - interval '2 hours'
$$;

revoke execute on function public.ctl_benefit_never_settled() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('benefit_never_settled',
   'A promo redemption on a finished booking was never settled or released',
   'high', 'money',
   'Redemptions reserve the worst-case cost at booking and are meant to settle to the '
   'real figure at capture, or be released if the booking dies. One that is still '
   'reserved after the booking reached a terminal state means a campaign budget is '
   'holding money against work that either finished at a different price or never '
   'happened — the campaign exhausts early and the user silently loses a benefit.',
   'ctl_benefit_never_settled')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
