-- Idempotency ledger for tips. stripe-tip now credits the earner's earnings
-- dashboard (today/week/total) in addition to charging the card — so a retried or
-- idempotently-replayed request must not double-credit. One row per PaymentIntent
-- (unique) gates the accumulate + credit: a duplicate insert means we've already
-- counted this tip. Service-role only (no client policies) — the edge function writes.
create table if not exists public.tip_ledger (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references public.bookings(id) on delete cascade,
  payment_intent_id text not null unique,
  earner_id         uuid references public.profiles(id) on delete set null,
  amount_cents      integer not null,
  created_at        timestamptz not null default now()
);

alter table public.tip_ledger enable row level security;
