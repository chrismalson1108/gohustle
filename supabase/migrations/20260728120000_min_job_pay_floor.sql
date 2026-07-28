-- ─────────────────────────────────────────────────────────────────────────────
-- DB backstop: a gig's pay RATE must be at least $10 (2026-07-28).
--
-- Follows 20260715050000_jobs_pay_positive.sql, which added `check (pay > 0) not
-- valid` for the same reason: the clients validate, but a direct PostgREST write
-- with a user's own token bypasses them entirely. That gap is wider than it looks
-- because there are now FOUR write paths into these tables — mobile, web, the AI
-- assistant edge function, and raw PostgREST.
--
-- WHY A TRIGGER AND NOT `check (pay >= 10)`:
-- Postgres evaluates CHECK constraints on UPDATE as well as INSERT, and NOT VALID
-- only skips the initial backfill scan — it does NOT exempt later updates. So a
-- plain CHECK would reject ANY update to a gig already posted below $10, including
-- innocuous ones like cancelling it or letting the bump cooldown rewrite bumped_at.
-- That would strand legacy rows in an uneditable state, which is worse than the
-- thing we're preventing.
--
-- This trigger fires only when pay is actually being INTRODUCED or CHANGED. A
-- legacy $5 gig can still be cancelled, completed, bumped or moderated; it just
-- can't have its pay re-set below the floor, and no new gig can be created below it.
--
-- counter_offer gets the same treatment: it REPLACES the posted rate and is set by
-- the EARNER, so a floor on jobs.pay alone is trivially undercut from the other side.
-- Note bookings.counter_offer is nullable (null = "accept the listed rate"), so null
-- must stay legal — only a non-null value below the floor is rejected.
--
-- Keep the 10 in sync with MIN_JOB_PAY in shared/constants.js,
-- supabase/functions/stripe-create-payment-intent/index.ts and
-- supabase/functions/assistant/index.ts.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_job_pay_floor()
returns trigger
language plpgsql
as $$
begin
  -- Only when pay is being set or changed. Leaves legacy sub-floor rows updatable.
  if tg_op = 'INSERT' or new.pay is distinct from old.pay then
    if new.pay is null or new.pay < 10 then
      raise exception 'Gigs must pay at least $10 (got %)', new.pay
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_booking_counter_offer_floor()
returns trigger
language plpgsql
as $$
begin
  -- null counter_offer means "accept the listed rate" and stays legal.
  if tg_op = 'INSERT' or new.counter_offer is distinct from old.counter_offer then
    if new.counter_offer is not null and new.counter_offer < 10 then
      raise exception 'Counter-offers must be at least $10 (got %)', new.counter_offer
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_job_pay_floor on public.jobs;
create trigger trg_guard_job_pay_floor
  before insert or update on public.jobs
  for each row execute function public.guard_job_pay_floor();

drop trigger if exists trg_guard_booking_counter_offer_floor on public.bookings;
create trigger trg_guard_booking_counter_offer_floor
  before insert or update on public.bookings
  for each row execute function public.guard_booking_counter_offer_floor();
