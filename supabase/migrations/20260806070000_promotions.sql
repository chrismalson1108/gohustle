-- ─────────────────────────────────────────────────────────────────────────────
-- Promotions: fee overrides, codes, grants, and a bonus ledger (2026-08-06).
--
-- TWO MECHANISMS, DELIBERATELY SEPARATED, BECAUSE THEY CARRY DIFFERENT RISK
--
--   FEE OVERRIDE  — "0% on your first 2 gigs", "5% for 30 days". Shrinks what the
--                   platform keeps. No cash leaves. Bounded by the gig value for free.
--                   Delivered through the pin that already exists: a grant lowers
--                   bookings.fee_bps_quoted at INSERT and everything downstream
--                   follows, including capture and claim.
--
--   BONUS         — "$10 per successful referral". Real value out. Recorded here as a
--                   LEDGER so it can be delivered either as a fee credit (offsets a
--                   future gig's platform fee; can never exceed what the user would
--                   have paid us; no Stripe transfer, no platform balance to manage)
--                   or later as cash. Only 'credit' is enabled by this migration.
--                   Cash payout is the classic farming target and is not turned on
--                   without a deliberate decision.
--
-- HOW A PROMOTION ENDS — three independent levers, because the failure mode that
-- actually costs money is forgetting one is running:
--   1. ends_at passes            → stops matching. NO ACTION REQUIRED. The default.
--   2. status = 'paused'         → immediate, reversible. For "this is being abused".
--   3. app_flags.promotions_enabled = false → everything off at once. Incident switch.
--
-- ENDING A CAMPAIGN NEVER RE-PRICES AGREED WORK. The benefit is snapshotted onto the
-- grant (promo_grants.fee_bps) and then onto the booking's pin. Someone who booked at
-- 0% keeps 0% even if the promo is killed a minute later. Retroactive re-pricing would
-- be both a disclosure failure and a support nightmare.
--
-- LOSS IS BOUNDED BY CONSTRUCTION, NOT BY VIGILANCE. Every promotion carries a
-- budget_cents and a max_redemptions, both NOT NULL with real defaults, and
-- consume_promo_grant() makes THE INCREMENT BE THE CHECK — a single UPDATE ... WHERE
-- spent < budget with get diagnostics, never read-then-decide. Read-then-write is the
-- race that hands out the last dollar fifty times.
--
-- STACKING DIES AT THE DATABASE. Two unique indexes: one grant per user per promotion,
-- one grant per booking. OWASP lists discount-code chaining as its own attack class
-- precisely because application-level checks race.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Campaigns ────────────────────────────────────────────────────────────────
create table if not exists public.promotions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kind              text not null default 'fee_override'
                      check (kind in ('fee_override', 'bonus')),
  status            text not null default 'draft'
                      check (status in ('draft', 'active', 'paused', 'ended')),

  -- fee_override: the rate this grant pins instead of the standing rate.
  -- 0 is legal and means "no platform margin" — platform_fee_cents still floors at
  -- processing cost, so it is never actually free to us and never a loss.
  fee_bps           integer check (fee_bps is null or fee_bps between 0 and 3000),
  -- How many bookings one grant covers. "First 2 gigs free" is uses_allowed = 2.
  uses_allowed      integer not null default 1 check (uses_allowed between 1 and 20),

  -- bonus: value per qualifying event, and how it is delivered.
  bonus_cents       integer check (bonus_cents is null or bonus_cents between 0 and 50000),
  bonus_delivery    text not null default 'credit'
                      check (bonus_delivery in ('credit', 'cash')),

  -- Ceilings. NOT NULL with real defaults: a promotion with no ceiling is not a
  -- promotion, it is an incident waiting for someone to notice.
  max_redemptions   integer not null default 100 check (max_redemptions > 0),
  redemptions_used  integer not null default 0 check (redemptions_used >= 0),
  budget_cents      integer not null default 25000 check (budget_cents > 0),
  spent_cents       integer not null default 0 check (spent_cents >= 0),
  -- Per-booking cap on how much benefit a single use may consume.
  max_benefit_cents integer not null default 15000 check (max_benefit_cents > 0),

  starts_at         timestamptz not null default now(),
  ends_at           timestamptz,
  note              text,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),

  -- A fee_override must say what rate; a bonus must say how much. Neither may be
  -- half-configured, because a half-configured promotion fails at redemption time
  -- in front of a user.
  constraint promotions_kind_shape check (
    (kind = 'fee_override' and fee_bps is not null and bonus_cents is null) or
    (kind = 'bonus'        and bonus_cents is not null and fee_bps is null)
  )
);

create index if not exists promotions_live_idx
  on public.promotions (status, starts_at, ends_at) where status = 'active';

-- ── Redeemable codes ─────────────────────────────────────────────────────────
-- promotions.max_redemptions is a BUDGET control; promo_codes.max_redemptions is a
-- LEAK control. A campus code posted to a deals subreddit burns its own seat, not the
-- whole campaign.
create table if not exists public.promo_codes (
  id               uuid primary key default gen_random_uuid(),
  promotion_id     uuid not null references public.promotions(id) on delete cascade,
  code             text not null check (length(btrim(code)) between 6 and 32),
  -- Bind a code to one person for invite-style and referral rewards.
  bound_user_id    uuid references public.profiles(id) on delete cascade,
  max_redemptions  integer not null default 1 check (max_redemptions > 0),
  redemptions_used integer not null default 0 check (redemptions_used >= 0),
  expires_at       timestamptz,
  source           text,
  created_at       timestamptz not null default now()
);

create unique index if not exists promo_codes_code_uniq
  on public.promo_codes (upper(btrim(code)));

-- ── Grants: a user's claim on a campaign ─────────────────────────────────────
create table if not exists public.promo_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  promotion_id  uuid not null references public.promotions(id) on delete cascade,
  code_id       uuid references public.promo_codes(id) on delete set null,
  -- SNAPSHOT at claim time. The trigger reads THIS, never promotions.fee_bps, so an
  -- admin editing a live campaign cannot retroactively re-price a claim someone is
  -- already holding.
  fee_bps       integer,
  uses_allowed  integer not null default 1,
  uses_consumed integer not null default 0 check (uses_consumed >= 0),
  benefit_cents integer not null default 0,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- One claim per user per campaign, at the database, where it cannot race.
create unique index if not exists promo_grants_one_per_user_promo
  on public.promo_grants (user_id, promotion_id);
create index if not exists promo_grants_live_idx
  on public.promo_grants (user_id) where uses_consumed < uses_allowed;

-- ── Which grant paid for which booking ───────────────────────────────────────
-- Separate from grants because a grant can span several bookings ("first 2 gigs").
-- The unique index on booking_id is what kills discount stacking.
create table if not exists public.promo_redemptions (
  id            uuid primary key default gen_random_uuid(),
  grant_id      uuid not null references public.promo_grants(id) on delete cascade,
  promotion_id  uuid not null references public.promotions(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  booking_id    uuid not null,
  fee_bps       integer not null,
  -- Stamped at capture, when the real cost is known. Until then the campaign is
  -- charged max_benefit_cents so the budget cannot be oversubscribed by in-flight work.
  benefit_cents integer not null default 0,
  reserved_cents integer not null default 0,
  settled       boolean not null default false,
  created_at    timestamptz not null default now()
);

create unique index if not exists promo_redemptions_one_per_booking
  on public.promo_redemptions (booking_id);

-- ── Bonus ledger ─────────────────────────────────────────────────────────────
-- Vest-on-outcome. A referral bonus is CREATED when the referred person's gig is
-- verified and becomes PAYABLE only after the refund window closes with no reversal.
-- Farming therefore requires doing real work and paying real fees on both sides,
-- which is what makes it unprofitable rather than merely detectable.
create table if not exists public.bonus_ledger (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  promotion_id  uuid references public.promotions(id) on delete set null,
  reason        text not null,
  amount_cents  integer not null check (amount_cents > 0),
  delivery      text not null default 'credit' check (delivery in ('credit', 'cash')),
  state         text not null default 'pending'
                  check (state in ('pending', 'payable', 'applied', 'void')),
  -- What triggered it, for audit and for de-duplication.
  source_booking_id uuid,
  source_user_id    uuid references public.profiles(id) on delete set null,
  vests_at      timestamptz,
  applied_at    timestamptz,
  applied_booking_id uuid,
  void_reason   text,
  created_at    timestamptz not null default now()
);

-- One bonus per (reason, source booking, beneficiary). Re-running the vesting job,
-- or a webhook arriving twice, must not mint a second bonus.
create unique index if not exists bonus_ledger_dedupe
  on public.bonus_ledger (user_id, reason, source_booking_id)
  where source_booking_id is not null;
create index if not exists bonus_ledger_payable_idx
  on public.bonus_ledger (user_id) where state = 'payable';

-- ── Lockdown ─────────────────────────────────────────────────────────────────
-- Same posture as app_flags: RLS on, no policies, grants revoked. The client never
-- reads a promotion directly — it submits a CODE STRING and is told yes or no.
-- The one exception is a user seeing their own grants and bonuses, which is
-- disclosure they are entitled to.
alter table public.promotions        enable row level security;
alter table public.promo_codes       enable row level security;
alter table public.promo_grants      enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.bonus_ledger      enable row level security;
revoke all on public.promotions, public.promo_codes, public.promo_grants,
              public.promo_redemptions, public.bonus_ledger
  from anon, authenticated;
grant all on public.promotions, public.promo_codes, public.promo_grants,
             public.promo_redemptions, public.bonus_ledger
  to service_role;

grant select on public.promo_grants, public.bonus_ledger to authenticated;
-- Idempotent: a migration that cannot be re-run is a migration that will one day
-- half-apply and leave the schema in a state nobody can reproduce.
drop policy if exists promo_grants_own_select on public.promo_grants;
create policy promo_grants_own_select on public.promo_grants
  for select using (auth.uid() = user_id);
drop policy if exists bonus_ledger_own_select on public.bonus_ledger;
create policy bonus_ledger_own_select on public.bonus_ledger
  for select using (auth.uid() = user_id);

-- ── The global kill switch ───────────────────────────────────────────────────
insert into public.app_flags (key, enabled, note) values
  ('promotions_enabled', true,
   'Master switch for ALL promotions. OFF = no code redeems and no grant applies to a '
   'NEW booking. Bookings already pinned are unaffected — killing a campaign must '
   'never re-price agreed work.')
on conflict (key) do nothing;

-- Bonus payout stays OFF until it is deliberately turned on. Credits are bounded by
-- what the user would have paid us; cash is not.
insert into public.app_flags (key, enabled, note) values
  ('bonus_cash_payout_enabled', false,
   'OFF. Bonuses accrue as fee CREDITS only. Turning this on enables real transfers '
   'off the platform balance and needs balance monitoring and transfer-failure '
   'handling first.')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Redemption
-- ─────────────────────────────────────────────────────────────────────────────

-- Attempt log. The rate limit MUST count attempts, not successes: a brute-force sweep
-- produces only failures, so counting grants (which failures never create) would leave
-- the limiter reading zero forever while someone walked the keyspace.
create table if not exists public.promo_redeem_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ok         boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists promo_redeem_attempts_user_idx
  on public.promo_redeem_attempts (user_id, created_at desc);
alter table public.promo_redeem_attempts enable row level security;
revoke all on public.promo_redeem_attempts from anon, authenticated;
grant all on public.promo_redeem_attempts to service_role;

-- The ONLY thing a client ever sends is a code string. No percentage, no amount, no
-- promotion id. It gets back true/false and nothing else — distinct error strings
-- would turn this into a free existence oracle over a human-typeable keyspace.
create or replace function public.redeem_promo_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  c     public.promo_codes%rowtype;
  p     public.promotions%rowtype;
  tries integer;
  okv   boolean := false;
begin
  if uid is null then return false; end if;

  -- Count ATTEMPTS in the window, not successes. 8/hour.
  select count(*) into tries from public.promo_redeem_attempts
   where user_id = uid and created_at > now() - interval '1 hour';
  if tries >= 8 then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  select * into c from public.promo_codes
   where upper(btrim(code)) = upper(btrim(p_code));
  if not found
     or (c.expires_at is not null and c.expires_at <= now())
     or (c.bound_user_id is not null and c.bound_user_id <> uid) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  select * into p from public.promotions where id = c.promotion_id;
  if not found or p.status <> 'active' or p.starts_at > now()
     or (p.ends_at is not null and p.ends_at <= now()) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  -- ALREADY CLAIMED: succeed idempotently WITHOUT burning a code seat. Incrementing
  -- first and inserting second meant a user retyping their own code consumed a
  -- redemption every time, silently draining a campus code from the person holding it.
  if exists (select 1 from public.promo_grants where user_id = uid and promotion_id = p.id) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, true);
    return true;
  end if;

  -- Increment IS the check — no read-then-decide window.
  update public.promo_codes
     set redemptions_used = redemptions_used + 1
   where id = c.id and redemptions_used < max_redemptions;
  if not found then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  -- SNAPSHOT the benefit. A later admin edit cannot re-price this claim.
  insert into public.promo_grants (user_id, promotion_id, code_id, fee_bps, uses_allowed, expires_at)
  values (uid, p.id, c.id, p.fee_bps, p.uses_allowed, p.ends_at)
  on conflict (user_id, promotion_id) do nothing;
  okv := found;

  -- Lost a race to a concurrent claim: hand the seat back rather than eat it.
  if not okv then
    update public.promo_codes set redemptions_used = greatest(0, redemptions_used - 1) where id = c.id;
    okv := true;  -- they hold a grant either way, so this is still a success
  end if;

  insert into public.promo_redeem_attempts (user_id, ok) values (uid, okv);
  return okv;
exception when others then
  -- Never leak internals to a caller probing codes.
  return false;
end;
$$;

revoke execute on function public.redeem_promo_code(text) from public, anon;
grant  execute on function public.redeem_promo_code(text) to authenticated, service_role;

-- Called from the booking pin trigger. Returns the fee_bps to use, or NULL to mean
-- "no promotion applies, use the standing rate".
--
-- Everything that could fail is inside the caller's exception handler: a promotion bug
-- must never stop someone booking a gig. Losing a discount is recoverable; losing the
-- booking is not.
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

  -- Best eligible grant = lowest fee for the user. FOR UPDATE so two concurrent
  -- bookings cannot both consume the last use.
  select g2.* into g
    from public.promo_grants g2
    join public.promotions p2 on p2.id = g2.promotion_id
   where g2.user_id = p_user
     and g2.uses_consumed < g2.uses_allowed
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

  -- Reserve against the ceiling BEFORE granting. The increment is the check, so
  -- there is no window where two bookings both see budget remaining.
  -- reserved = the WORST case cost of this use; the real figure is settled at capture.
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
    -- Campaign is exhausted. Silently fall through to the standing rate: a booking
    -- must still succeed, just without the discount.
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

-- ── Wire it into the existing pin ────────────────────────────────────────────
-- Reproduced in full (create or replace needs the whole body). The promo block is
-- wrapped so ANY failure leaves the booking pinned at the standing rate rather than
-- aborting the insert.
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

    -- A promotion may only ever LOWER the rate. least() means a malformed or
    -- malicious promotion cannot raise someone's fee above the standing rate.
    begin
      promoBps := public.consume_promo_grant(new.earner_id, new.id, new.amount_cents_quoted);
      if promoBps is not null then
        new.fee_bps_quoted := least(new.fee_bps_quoted, promoBps);
      end if;
    exception when others then
      raise warning 'promo application failed for booking %: %', new.id, sqlerrm;
    end;

    return new;
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.amount_cents_quoted := old.amount_cents_quoted;
    new.fee_bps_quoted      := old.fee_bps_quoted;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_booking_amount() from public, anon, authenticated;
