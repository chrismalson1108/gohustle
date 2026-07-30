-- ─────────────────────────────────────────────────────────────────────────────
-- Enforce the pay CEILING server-side (2026-07-30).
--
-- shared/constants.js has declared `MAX_JOB_PAY = 10000` since the floor landed,
-- and validateJobPay() rejects anything above it — but only in the two clients.
-- Nothing server-side ever checked an upper bound:
--
--   * guard_job_pay_floor (20260728120000/130000) tests only `new.pay < 10`.
--   * the assistant's post_job tool tests only `pay < MIN_JOB_PAY`.
--   * stripe-create-payment-intent DOES cap the escrow amount at 1_000_000 cents,
--     which is the backstop that keeps this out of money-loss territory.
--
-- So the ceiling was advisory. Production already holds a $20,000 listing, which
-- is how this was found: it is double MAX_JOB_PAY, and it cannot be paid for —
-- an earner can book it, and the poster's escrow authorization is then rejected
-- at accept time by the amount cap. That is a dead-end booking for both parties.
--
-- This is exactly the reasoning the assistant's own floor check records: refusing
-- up front beats letting a gig be posted that dead-ends at escrow, and it is a
-- normal user path, not an attack. The ceiling deserves the same treatment.
--
-- It also skews the product: Market Insights averages raw pay, so that one row
-- reported the Dallas average gig as $6,733 to students pricing their own work.
--
-- Counter-offers get the same bound. The EARNER sets counter_offer, and the same
-- escrow cap applies to it, so a floor-only guard leaves the mirror-image hole.
--
-- Generated from 20260728130000 by a scripted replacement so the rest of each
-- body (the tg_op/is-distinct-from gating that leaves legacy rows updatable) is
-- byte-identical to the authoritative version. Behaviour on existing rows is
-- unchanged: the check fires only when pay/counter_offer is set or changed, so
-- the legacy $20,000 row stays editable in every other respect and no live data
-- is destroyed. Cleaning that row up is a separate, deliberate call.
--
-- Keep 10000 in sync with MAX_JOB_PAY in shared/constants.js. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_job_pay_floor()
returns trigger
language plpgsql
as $$
begin
  -- Only when pay is being set or changed. Leaves legacy sub-floor rows updatable.
  if tg_op = 'INSERT' or new.pay is distinct from old.pay then
    if new.pay is null or new.pay < 10 then
      raise exception 'Gigs must pay at least $10.'
        using errcode = 'check_violation';
    end if;
    if new.pay > 10000 then
      raise exception 'Gigs can''t pay more than $10,000.'
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
      raise exception 'Counter-offers must be at least $10.'
        using errcode = 'check_violation';
    end if;
    if new.counter_offer is not null and new.counter_offer > 10000 then
      raise exception 'Counter-offers can''t be more than $10,000.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
