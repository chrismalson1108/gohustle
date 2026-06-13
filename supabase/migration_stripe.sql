-- ============================================================
-- GoHustlr — Stripe Payment Tables
-- Run in Supabase SQL Editor after migration_fix_lifecycle.sql
-- ============================================================

-- Stripe customer IDs for posters (paying for jobs)
create table if not exists public.stripe_customers (
  user_id     uuid references public.profiles(id) on delete cascade primary key,
  customer_id text unique not null,
  created_at  timestamptz default now()
);

-- Stripe Connect Express account IDs for earners (receiving payouts)
create table if not exists public.stripe_accounts (
  user_id    uuid references public.profiles(id) on delete cascade primary key,
  account_id text unique not null,
  onboarded  boolean not null default false,
  created_at timestamptz default now()
);

-- One payment record per booking
create table if not exists public.payments (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid references public.bookings(id) on delete cascade unique not null,
  payment_intent_id     text unique not null,
  amount_cents          integer not null,           -- total charged to poster
  fee_cents             integer not null,            -- GoHustlr 10% cut
  earner_amount_cents   integer not null,            -- transferred to earner on capture
  currency              text not null default 'usd',
  status                text not null default 'authorized'
                          check (status in ('authorized','captured','cancelled','failed')),
  captured_at           timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz default now()
);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.stripe_customers enable row level security;
alter table public.stripe_accounts  enable row level security;
alter table public.payments         enable row level security;

create policy "stripe_customers_own"
  on public.stripe_customers for all
  using (auth.uid() = user_id);

create policy "stripe_accounts_own"
  on public.stripe_accounts for all
  using (auth.uid() = user_id);

-- Earner can see the payment record on their booking
create policy "payments_earner_select"
  on public.payments for select
  using (
    exists (
      select 1 from public.bookings
      where id = booking_id and earner_id = auth.uid()
    )
  );

-- Poster can see the payment record for bookings on their jobs
create policy "payments_poster_select"
  on public.payments for select
  using (
    exists (
      select 1 from public.bookings b
      join public.jobs j on b.job_id = j.id
      where b.id = booking_id and j.poster_id = auth.uid()
    )
  );

-- Enable realtime for payments table so earner gets notified when captured
alter publication supabase_realtime add table public.payments;
