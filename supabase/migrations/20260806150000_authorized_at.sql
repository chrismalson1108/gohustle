-- ─────────────────────────────────────────────────────────────────────────────
-- payments.authorized_at: when the CURRENT hold was placed (2026-08-06).
--
-- THE BUG. ctl_escrow_hold_lapsed_uncancelled and ctl_escrow_hold_expiring_work_done
-- both age a hold with `greatest(p.created_at, p.cancelled_at)`. Neither column records
-- the current hold on a RECOVERY re-hold: stripe-create-payment-intent's upsert writes
-- booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents and
-- status — not created_at, and stripe-webhook is the only writer of cancelled_at.
--
-- So: a hold placed 1 Jun lapses 8 Jun (cancelled_at = 8 Jun). On 8 Jul the poster
-- re-accepts and a fresh 7-day authorization is placed. Both controls date it to 8 Jun,
-- compute it as 30 days old, and file a CRITICAL finding the instant a perfectly
-- healthy hold is created. A control that fires on the correct behaviour is worse than
-- no control: it is the recovery path, so it fires exactly when someone is already
-- fixing a problem.
--
-- WHY NOT JUST SET created_at = now() ON RECOVERY. Because created_at is the record of
-- the ORIGINAL authorization: ctl_money_exposed_on_dead_booking reads
-- coalesce(b.created_at, p.created_at), and admin/app/(console)/payments/page.tsx
-- orders by it. Rewriting it would destroy audit history and corrupt another control to
-- fix this one. A new column costs nothing and lies about nothing.
--
-- Backfilled to greatest(created_at, cancelled_at) so existing rows are no worse than
-- today, and the controls switch to coalesce(authorized_at, …) so they keep working on
-- any row the backfill could not improve.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.payments
  add column if not exists authorized_at timestamptz;

comment on column public.payments.authorized_at is
  'When the CURRENT authorization was placed. Distinct from created_at, which records '
  'the FIRST one and is read by other controls and the payments list — a recovery '
  're-hold updates this and leaves that history intact.';

update public.payments
   set authorized_at = greatest(created_at, cancelled_at)
 where authorized_at is null;

create or replace function public.ctl_escrow_hold_lapsed_uncancelled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'booking_id', p.booking_id,
           'payment_intent_id', p.payment_intent_id,
           'amount_cents', p.amount_cents,
           'booking_status', b.status,
           'earner_done', b.earner_done,
           -- authorized_at is the age of the CURRENT hold; created_at would date a
           -- recovery re-hold to the original authorization and fire immediately.
           'hold_placed_at', coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)),
           'hold_age_days', round(extract(epoch from now()
              - coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at))) / 86400.0, 1))
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.status = 'authorized'
     and coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) < now() - interval '8 days'
     and b.status not in ('cancelled', 'declined')
$$;

create or replace function public.ctl_escrow_hold_expiring_work_done()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'booking_id', p.booking_id,
           'amount_cents', p.amount_cents,
           'booking_status', b.status,
           'hold_placed_at', coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)),
           'hours_until_expiry', round(extract(epoch from
              (coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) + interval '7 days') - now()) / 3600.0, 1))
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.status = 'authorized'
     and b.status in ('completed', 'verified')
     and coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) < now() - interval '5 days'
     and coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) >= now() - interval '8 days'
$$;

revoke execute on function public.ctl_escrow_hold_lapsed_uncancelled() from public, anon, authenticated;
revoke execute on function public.ctl_escrow_hold_expiring_work_done() from public, anon, authenticated;
