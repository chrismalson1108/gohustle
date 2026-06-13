-- Trial-readiness P0: legal acceptance, reports, blocks, and a cash-income log
-- for the Tax Center. Owner-scoped RLS. Idempotent.

-- Legal acceptance on the profile
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;

-- Reports (moderation queue; readable only by the reporter, insert own)
create table if not exists public.reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete set null,
  job_id           uuid references public.jobs(id) on delete set null,
  booking_id       uuid references public.bookings(id) on delete set null,
  reason           text not null,
  details          text,
  created_at       timestamptz default now()
);
alter table public.reports enable row level security;
drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports for insert with check (auth.uid() = reporter_id);
drop policy if exists "reports_select_own" on public.reports;
create policy "reports_select_own" on public.reports for select using (auth.uid() = reporter_id);

-- Blocks (a user hides another)
create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (blocker_id, blocked_id)
);
alter table public.blocks enable row level security;
drop policy if exists "blocks_select_own" on public.blocks;
create policy "blocks_select_own" on public.blocks for select using (auth.uid() = blocker_id);
drop policy if exists "blocks_insert_own" on public.blocks;
create policy "blocks_insert_own" on public.blocks for insert with check (auth.uid() = blocker_id);
drop policy if exists "blocks_delete_own" on public.blocks;
create policy "blocks_delete_own" on public.blocks for delete using (auth.uid() = blocker_id);

-- Cash / other income entries for the Tax Center (Stripe income is tracked
-- separately via earnings; this captures off-platform income like cash tips).
create table if not exists public.income_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      numeric(10,2) not null,
  source      text not null default 'cash',
  description text,
  date        date not null default current_date,
  created_at  timestamptz default now()
);
create index if not exists income_user_date_idx on public.income_entries (user_id, date desc);
alter table public.income_entries enable row level security;
drop policy if exists "income_select_own" on public.income_entries;
create policy "income_select_own" on public.income_entries for select using (auth.uid() = user_id);
drop policy if exists "income_insert_own" on public.income_entries;
create policy "income_insert_own" on public.income_entries for insert with check (auth.uid() = user_id);
drop policy if exists "income_update_own" on public.income_entries;
create policy "income_update_own" on public.income_entries for update using (auth.uid() = user_id);
drop policy if exists "income_delete_own" on public.income_entries;
create policy "income_delete_own" on public.income_entries for delete using (auth.uid() = user_id);
