-- ─────────────────────────────────────────────────────────────────────────────
-- Job-start tracking + cancellation safety.
--
-- Adds an explicit "in progress" point to the booking lifecycle and a guard that
-- blocks cancelling a booking once the worker has started on site.
--
--   * bookings.started_at       — set by the earner's "Start job / I'm on site"
--                                 action; presence means work is underway.
--   * bookings.cancellation_fee — recorded (display/policy only) when a poster
--                                 cancels a confirmed, not-yet-started booking.
--                                 NO money moves here — this is a record, not a charge.
--
-- A dedicated BEFORE UPDATE trigger raises when a started booking is cancelled, so
-- the rule is enforced at the DB even if a client skips the in-app check. We keep
-- this separate from guard_bookings_write (the escrow-reviewed status guard) so the
-- payment-capture logic there is untouched; that guard silently reverts illegal
-- transitions, whereas here we want a hard, user-facing error.
--
-- Idempotent: add-column-if-not-exists + create-or-replace + drop-trigger-if-exists.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists started_at timestamptz;
alter table public.bookings add column if not exists cancellation_fee numeric(10,2);

-- ── Block cancelling a job that has already started ───────────────────────────
create or replace function public.guard_started_booking_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.started_at is not null then
    raise exception 'Cannot cancel a job that has already started — open a dispute instead.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_started_booking_cancel on public.bookings;
create trigger trg_guard_started_booking_cancel
  before update on public.bookings
  for each row execute function public.guard_started_booking_cancel();
