-- ─────────────────────────────────────────────────────────────────────────────
-- Correctness (MEDIUM, money reporting): GMV counted the AUTHORIZED hold, not the
-- amount actually captured (2026-07-26).
--
-- admin_dashboard_metrics computed:
--     'gmv_captured_cents', sum(amount_cents) where status = 'captured'
--
-- but `payments.amount_cents` is the ORIGINAL authorization and is deliberately never
-- rewritten — stripe-capture-payment keeps it as the immutable audit record and says
-- so, deriving the fee from it precisely because the mutable columns get rescaled on
-- a partial capture. After a dispute/partial capture the poster is charged as little
-- as half of it (the capture floor is 50%), so every partially-captured booking
-- inflated GMV by up to 2x, and the fee/earner columns no longer reconcile against it.
--
-- The captured total is exactly what the capture path writes back:
--     earner_amount_cents + fee_cents
-- (stripe-capture-payment: "the captured total is derivable as earner_amount_cents +
-- fee_cents"; earner-claim-payment reconciles both columns to Stripe's actual
-- amount_received before crediting). Summing those two gives the real collected
-- figure for full and partial captures alike.
--
-- escrow_held_cents is left on amount_cents and that is correct: an 'authorized' row
-- has not been captured, so the authorization IS the amount held.
--
-- Only the gmv_captured_cents expression changes; every other metric is copied
-- verbatim from 20260705040000_admin_console_v2.sql. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_dashboard_metrics()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'users_total',        (select count(*) from public.profiles),
    'signups_today',      (select count(*) from public.profiles where created_at >= date_trunc('day', now())),
    'signups_7d',         (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
    'signups_30d',        (select count(*) from public.profiles where created_at >= now() - interval '30 days'),
    'suspended_users',    (select count(*) from public.profiles where suspended_at is not null),
    'jobs_open',          (select count(*) from public.jobs where status = 'open'),
    'jobs_total',         (select count(*) from public.jobs),
    'bookings_pending',   (select count(*) from public.bookings where status = 'pending'),
    'bookings_confirmed', (select count(*) from public.bookings where status = 'confirmed'),
    'bookings_completed', (select count(*) from public.bookings where status = 'completed'),
    'bookings_verified',  (select count(*) from public.bookings where status = 'verified'),
    -- Actually collected, not authorized. See banner.
    'gmv_captured_cents', (select coalesce(sum(coalesce(earner_amount_cents, 0) + coalesce(fee_cents, 0)), 0)
                             from public.payments where status = 'captured'),
    'fees_captured_cents',(select coalesce(sum(fee_cents), 0)    from public.payments where status = 'captured'),
    -- Correct as-is: an authorized row is uncaptured, so the authorization is the hold.
    'escrow_held_cents',  (select coalesce(sum(amount_cents), 0) from public.payments where status = 'authorized'),
    'disputes_total',     (select count(*) from public.disputes),
    'disputes_7d',        (select count(*) from public.disputes where created_at >= now() - interval '7 days'),
    'reports_total',      (select count(*) from public.reports),
    'reports_7d',         (select count(*) from public.reports where created_at >= now() - interval '7 days')
  )
$$;

revoke execute on function public.admin_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to service_role;
