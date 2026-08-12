-- ─────────────────────────────────────────────────────────────────────────────
-- Pin the agreed amount onto the booking at INSERT (2026-08-06).
--
-- THE BUG THIS CLOSES — an earner can be silently re-priced after applying.
--
-- guard_jobs_write decides whether a gig's core terms are locked by asking whether
-- the job has a LIVE booking:
--
--     select exists (select 1 from public.bookings b
--       where b.job_id = old.id and b.status in ('confirmed','completed','verified'))
--     into has_active;
--     if not has_active then return new; end if;   -- poster may edit freely
--
-- 'pending' is not in that list. A pending application therefore locks NOTHING, and
-- stripe-create-payment-intent computes the charge from the job row as it stands at
-- ACCEPT time:
--
--     const rate = booking.counter_offer ? … : Number(booking.job.pay);
--
-- So: an earner applies to a $200 gig at the listed price. The poster edits pay to
-- $10 — permitted, because the booking is only 'pending' — and then accepts. The
-- authorization is placed for $10. The earner agreed to $200, was never re-asked,
-- and nothing in the product tells them the number moved. MIN_JOB_PAY bottoms this
-- out at $10 rather than $0, and the earner can still cancel before marking started
-- IF they happen to notice; neither is consent.
--
-- Only earners who took the listed price are exposed: counter_offer is stored on the
-- booking and pinned to old.* on both UPDATE branches, so it already survives a job
-- edit. This makes the listed-price case behave the same way.
--
-- WHY NOT JUST ADD 'pending' TO has_active
--
-- It would close the hole and it is one word, but it is the worse fix: the listing
-- would freeze the moment any application arrives, so a poster could no longer fix a
-- typo while waiting — and it hands any earner a griefing primitive, since applying
-- would be enough to lock a stranger's gig. Pinning the amount constrains only the
-- number that must not move, and leaves the listing editable.
--
-- WHY A SEPARATE TRIGGER RATHER THAN EDITING guard_bookings_write
--
-- Two reasons. First, guard_bookings_write is the most safety-critical function on
-- this table and rewriting 6.4KB of it to add two assignments is risk with no upside.
-- Second — and this is the one that matters — it opens with
--
--     if coalesce(auth.role(), '') = 'service_role' then return new; end if;
--
-- which is correct for an authorization guard (the service role IS trusted to write
-- what it likes) but wrong for a price pin. The assistant edge function inserts
-- bookings server-side; those must be pinned too, or the assistant path keeps the
-- bug. This trigger deliberately has NO service-role bypass on INSERT.
--
-- trg_z_* so it fires LAST among the BEFORE triggers on bookings — specifically
-- after trg_guard_booking_counter_offer_floor, so the counter_offer it reads is the
-- floored one, not the raw client value.
--
-- The column is NULLABLE ON PURPOSE. Existing rows stay null and
-- stripe-create-payment-intent keeps its current computation for them, so this
-- migration changes the behaviour of exactly zero in-flight bookings. New bookings
-- get a pin from the moment it lands. Nothing needs to be backfilled and there is no
-- flag day.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings
  add column if not exists amount_cents_quoted integer;

comment on column public.bookings.amount_cents_quoted is
  'Server-stamped total (cents) the two parties agreed to, frozen at INSERT. '
  'stripe-create-payment-intent authorizes THIS, not a recomputation from the live '
  'job row, so a poster editing jobs.pay while a booking is pending cannot re-price '
  'an application the earner already made. Null on rows predating 20260806000000.';

create or replace function public.pin_booking_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j record;
begin
  if tg_op = 'INSERT' then
    select pay, pay_type, estimated_hours into j
      from public.jobs where id = new.job_id;

    -- No job row: let the FK and guard_bookings_write reject it. Masking that here
    -- with a fabricated amount would turn a clean rejection into a priced booking.
    if not found or j.pay is null then
      return new;
    end if;

    -- Mirrors stripe-create-payment-intent exactly: counter_offer when the earner
    -- named one, else the listed pay; multiplied by estimated_hours for hourly.
    -- The edge function's bounds checks (min 50c, max $10k, MIN_JOB_PAY on the rate)
    -- are NOT duplicated here — they stay where they are, so this trigger records
    -- what was agreed and the payment path still decides what is chargeable.
    new.amount_cents_quoted := round(
      coalesce(new.counter_offer, j.pay)
      * (case when j.pay_type = 'hourly' then coalesce(j.estimated_hours, 1) else 1 end)
      * 100
    )::integer;

    return new;
  end if;

  -- UPDATE: immutable to both parties, for the same reason it exists at all.
  -- service_role may still correct it — admin remediation needs a way to fix a bad
  -- row, and every such path is already audited in admin_audit_log.
  if coalesce(auth.role(), '') <> 'service_role' then
    new.amount_cents_quoted := old.amount_cents_quoted;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_booking_amount() from public, anon, authenticated;

drop trigger if exists trg_z_pin_booking_amount on public.bookings;
create trigger trg_z_pin_booking_amount
  before insert or update on public.bookings
  for each row execute function public.pin_booking_amount();
