-- ─────────────────────────────────────────────────────────────────────────────
-- Audit follow-ups (2026-07-22).
--
--  #1 MEDIUM (data): profiles.earnings_today / earnings_week were only ever
--     INCREMENTED — by credit_earnings() (20260624220000_review5_db_fixes) and by
--     claim_and_credit_tip() (20260624240000_review7_db_fixes) — and never reset.
--     Nothing anywhere rolled the buckets over at midnight / at the start of the
--     week, so an earner's "today"/"this week" figures and their weekly-goal
--     progress inflated forever (the week bucket eventually equalled lifetime
--     earnings). Fix: track the last-credited calendar date on the profile and
--     zero the stale bucket BEFORE adding to it. earnings_total is never touched.
--
--  #2 LOW (privacy): area_market_stats() (20260629170000) still granted execute to
--     `anon`, despite the anon-read lockdowns (20260710020000 / 20260715030000).
--     Aggregates are cheap to scrape unauthenticated; restrict to authenticated.
--
-- Idempotent throughout (add column if not exists / create or replace / explicit
-- re-grants), so re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── #1 — period bookkeeping column ───────────────────────────────────────────
-- The calendar date (DB timezone, i.e. UTC) on which earnings_today/earnings_week
-- were last credited. Deliberately left NULL for existing rows: NULL reads as
-- "no period on record", so the first credit after this migration wipes whatever
-- inflated total each row is carrying today. Intentionally NOT added to the
-- profiles column grant (20260624221000) — it is owner-private like the earnings
-- columns themselves and is read through my_profile().
alter table public.profiles add column if not exists earnings_period_date date;

-- Roll the daily/weekly buckets forward for one profile. Zeroes earnings_today when
-- the stored date is not today, and earnings_week when the stored date falls in a
-- different ISO week (date_trunc('week', …) starts on Monday), then stamps today's
-- date. Callers invoke this immediately before incrementing, so a bucket is reset
-- at most once per period and a repeat call within the same day is a no-op.
-- earnings_total is never modified here.
create or replace function public.roll_earnings_period(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user is null then
    return;
  end if;
  update public.profiles
     set earnings_today = case
           when earnings_period_date is distinct from current_date then 0
           else coalesce(earnings_today, 0)
         end,
         earnings_week = case
           when earnings_period_date is null
             or date_trunc('week', earnings_period_date)
                is distinct from date_trunc('week', current_date) then 0
           else coalesce(earnings_week, 0)
         end,
         earnings_period_date = current_date
   where id = p_user;
end;
$$;

-- Internal helper only — the SECURITY DEFINER callers below run as the owner, so no
-- client ever needs execute on it.
revoke execute on function public.roll_earnings_period(uuid) from public, anon, authenticated;

-- The new column has to be pinned in the profiles guard like the earnings columns it
-- bookkeeps. UPDATE on profiles is table-wide for `authenticated` (only extra column
-- grants were ever added, e.g. 20260629180000), so without this an owner could PATCH
-- earnings_period_date = current_date every day: roll_earnings_period would then never
-- see a stale period, the buckets would never reset, and the exact bug fixed above
-- would be back. Faithful copy of the latest definition (20260715040000_age_floor_
-- hardening) with that one extra pin.
create or replace function public.guard_profiles_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('app.recompute', true) = 'on' then
    return new;
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() = old.id then
    -- owner may edit their own row, but cannot forge trust badges, self-rate,
    -- fabricate earnings, or touch moderation state.
    new.verified               := old.verified;
    new.id_verification_status := old.id_verification_status;
    new.rating                 := old.rating;
    new.review_count           := old.review_count;
    new.poster_rating          := old.poster_rating;
    new.poster_review_count    := old.poster_review_count;
    new.earnings_today         := old.earnings_today;
    new.earnings_week          := old.earnings_week;
    new.earnings_total         := old.earnings_total;
    new.earnings_period_date   := old.earnings_period_date;  -- server bookkeeping only
    new.suspended_at           := old.suspended_at;        -- admin-only (console)
    new.suspension_reason      := old.suspension_reason;   -- admin-only (console)
    -- date_of_birth is write-once (self-attested age floor): once set it cannot be
    -- changed or cleared by the owner, so a caught minor cannot self-unblock by
    -- nulling it. NULL→value (first-time backfill at onboarding/Settings) stays allowed.
    if old.date_of_birth is not null then
      new.date_of_birth := old.date_of_birth;
    end if;
    -- onboarding_done cannot be flipped back to false by the owner (prevents dodging
    -- gates by re-entering onboarding); completing onboarding (false→true) stays allowed.
    if old.onboarding_done then
      new.onboarding_done := true;
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- credit_earnings — unchanged from 20260624220000 except for the rollover call.
create or replace function public.credit_earnings(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount  integer;
  v_earner  uuid;
  v_dollars numeric;
begin
  update public.payments
     set earnings_credited = true
   where id = p_payment_id
     and coalesce(earnings_credited, false) = false
     and status = 'captured'
     and coalesce(earner_amount_cents, 0) > 0
   returning earner_amount_cents into v_amount;

  if v_amount is null then
    return false;  -- already credited, not captured, or nothing to credit
  end if;

  select b.earner_id into v_earner
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.id = p_payment_id;

  if v_earner is null then
    return false;
  end if;

  -- Reset a stale day/week bucket first, otherwise the increment below compounds
  -- onto a figure from a previous day/week and "today"/"this week" never go down.
  perform public.roll_earnings_period(v_earner);

  v_dollars := v_amount::numeric / 100;
  update public.profiles
     set earnings_today = coalesce(earnings_today, 0) + v_dollars,
         earnings_week  = coalesce(earnings_week,  0) + v_dollars,
         earnings_total = coalesce(earnings_total, 0) + v_dollars
   where id = v_earner;
  return true;
end;
$$;

-- claim_and_credit_tip — unchanged from 20260624240000 except for the rollover call;
-- tips hit the same two buckets and had the same stale-period bug.
create or replace function public.claim_and_credit_tip(
  p_pi text, p_booking uuid, p_earner uuid, p_cents integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  if p_cents is null or p_cents <= 0 then
    return;
  end if;

  -- Record the tip once (idempotent on the PaymentIntent id).
  insert into public.tip_ledger (booking_id, payment_intent_id, earner_id, amount_cents)
  values (p_booking, p_pi, p_earner, p_cents)
  on conflict (payment_intent_id) do nothing;

  -- Claim the credit: only the call that flips credited false->true increments, so
  -- a retry after a mid-way failure still credits exactly once. Runs in ONE
  -- transaction with the increments below, so a failure rolls the claim back.
  update public.tip_ledger set credited = true
   where payment_intent_id = p_pi and coalesce(credited, false) = false
   returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    return;
  end if;

  if p_booking is not null then
    update public.bookings
       set tip_amount = coalesce(tip_amount, 0) + p_cents::numeric / 100
     where id = p_booking;
  end if;
  if p_earner is not null then
    perform public.roll_earnings_period(p_earner);  -- see credit_earnings
    update public.profiles
       set earnings_today = coalesce(earnings_today, 0) + p_cents::numeric / 100,
           earnings_week  = coalesce(earnings_week,  0) + p_cents::numeric / 100,
           earnings_total = coalesce(earnings_total, 0) + p_cents::numeric / 100
     where id = p_earner;
  end if;
end;
$$;

-- `create or replace` preserves the existing ACL, but re-assert the intended grants
-- (20260702000000 / 20260702040000) so a rebuilt DB lands in the same state.
revoke execute on function public.credit_earnings(uuid) from public, anon, authenticated;
revoke execute on function public.claim_and_credit_tip(text, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.credit_earnings(uuid) to service_role;
grant execute on function public.claim_and_credit_tip(text, uuid, uuid, integer) to service_role;

-- Read-side half of the same bug: crediting is what rolls the buckets, so between
-- midnight and the next credit the client (UserContext reads my_profile()) would keep
-- showing yesterday's "today" / last week's "this week". Report zeroes for a stale
-- period instead. Read-only — no UPDATE here (my_profile stays STABLE); the stored
-- values are corrected by roll_earnings_period on the next credit. Everything else
-- about my_profile() (20260624221000) is unchanged: full owner row as jsonb.
create or replace function public.my_profile()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select case
    when p.earnings_period_date is not distinct from current_date then to_jsonb(p)
    else jsonb_set(
           jsonb_set(to_jsonb(p), '{earnings_today}', to_jsonb(0::numeric)),
           '{earnings_week}',
           to_jsonb(case
             when date_trunc('week', p.earnings_period_date)
                  is not distinct from date_trunc('week', current_date)
               then coalesce(p.earnings_week, 0)
             else 0::numeric
           end)
         )
  end
  from public.profiles p where p.id = auth.uid()
$$;

revoke execute on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;

-- ── #2 — area_market_stats is authenticated-only ─────────────────────────────
-- Aggregate market data is a product feature for signed-in users, not an open
-- endpoint; anon execute survived the anon-read lockdowns by being a function grant.
revoke execute on function public.area_market_stats() from public, anon;
grant execute on function public.area_market_stats() to authenticated;
