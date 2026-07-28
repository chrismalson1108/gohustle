-- ─────────────────────────────────────────────────────────────────────────────
-- Make the pay-floor rejection readable by a human (2026-07-28).
--
-- 20260728120000 raised 'Gigs must pay at least $10 (got %)'. That text is not
-- internal: the mobile client surfaces a failed insert's message directly, so a
-- tester on a build predating the client-side check saw the toast
--
--     Couldn't post your gig
--     Gigs must pay at least $10 (got 5.00)
--
-- "(got 5.00)" is debugger phrasing. It will keep reaching real users for as long
-- as any pre-1.3.3 build is installed — and store builds linger — so the DB
-- message has to read like product copy, not like a stack trace.
--
-- Behaviour is unchanged; only the message text differs. Idempotent.
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
  end if;
  return new;
end;
$$;
