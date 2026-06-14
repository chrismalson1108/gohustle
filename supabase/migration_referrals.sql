-- Referral program: a per-user code + a record of who referred whom. Idempotent.
alter table public.profiles add column if not exists referral_code text;
create unique index if not exists profiles_referral_code_idx on public.profiles (referral_code) where referral_code is not null;

create table if not exists public.referrals (
  referred_id uuid primary key references public.profiles(id) on delete cascade,
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz default now()
);
alter table public.referrals enable row level security;
drop policy if exists "referrals_insert_self" on public.referrals;
create policy "referrals_insert_self" on public.referrals for insert with check (auth.uid() = referred_id);
drop policy if exists "referrals_select_mine" on public.referrals;
create policy "referrals_select_mine" on public.referrals for select using (auth.uid() = referrer_id or auth.uid() = referred_id);
