-- ============================================================
-- GoHustlr — Supabase Schema
-- Run this in the Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- PROFILES (extends auth.users)
create table if not exists public.profiles (
  id               uuid references auth.users(id) on delete cascade primary key,
  name             text        not null default 'New Hustler',
  avatar_initial   text        not null default 'N',
  role             text        not null default 'earner' check (role in ('earner','poster')),
  rating           numeric(3,1) not null default 5.0,
  review_count     integer     not null default 0,
  verified         boolean     not null default false,
  member_since     text,
  xp               integer     not null default 0,
  streak_days      integer     not null default 0,
  earnings_today   numeric(10,2) not null default 0,
  earnings_week    numeric(10,2) not null default 0,
  earnings_total   numeric(10,2) not null default 0,
  weekly_earning_goal numeric(10,2) not null default 300,
  weekly_jobs_goal integer     not null default 5,
  weekly_jobs_done integer     not null default 0,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- JOBS
create table if not exists public.jobs (
  id               uuid primary key default gen_random_uuid(),
  title            text        not null,
  category         text        not null,
  pay              numeric(10,2) not null,
  pay_type         text        not null default 'flat' check (pay_type in ('flat','hourly')),
  location         text        not null,
  description      text        not null,
  urgent           boolean     not null default false,
  estimated_hours  numeric(4,1) not null default 2,
  status           text        not null default 'open' check (status in ('open','booked','completed','cancelled')),
  poster_id        uuid references public.profiles(id) on delete cascade not null,
  created_at       timestamptz default now()
);

-- JOB SLOTS
create table if not exists public.job_slots (
  id       uuid primary key default gen_random_uuid(),
  job_id   uuid references public.jobs(id) on delete cascade not null,
  label    text    not null,
  taken    boolean not null default false,
  created_at timestamptz default now()
);

-- JOB REQUIREMENTS
create table if not exists public.job_requirements (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid references public.jobs(id) on delete cascade not null,
  requirement text not null,
  sort_order integer not null default 0
);

-- BOOKINGS
create table if not exists public.bookings (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid references public.jobs(id) not null,
  earner_id    uuid references public.profiles(id) not null,
  slot_id      uuid,
  slot_label   text,
  counter_offer numeric(10,2),
  status       text not null default 'pending' check (status in ('pending','confirmed','completed','cancelled')),
  created_at   timestamptz default now(),
  unique(job_id, earner_id)
);

-- REVIEWS
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references public.jobs(id) not null,
  reviewer_id uuid references public.profiles(id),
  author      text        not null,
  rating      numeric(2,1) not null check (rating >= 1 and rating <= 5),
  text        text        not null,
  date        text,
  created_at  timestamptz default now()
);

-- BADGES
create table if not exists public.badges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  badge_key   text    not null,
  unlocked    boolean not null default false,
  unlocked_at timestamptz,
  unique(user_id, badge_key)
);

-- USER CHALLENGES
create table if not exists public.user_challenges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles(id) on delete cascade not null,
  challenge_id text    not null,
  icon         text,
  title        text,
  description  text,
  type         text    default 'daily',
  progress     integer not null default 0,
  target       integer not null,
  xp_reward    integer not null default 50,
  expires_label text,
  completed    boolean not null default false,
  updated_at   timestamptz default now(),
  unique(user_id, challenge_id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles        enable row level security;
alter table public.jobs            enable row level security;
alter table public.job_slots       enable row level security;
alter table public.job_requirements enable row level security;
alter table public.bookings        enable row level security;
alter table public.reviews         enable row level security;
alter table public.badges          enable row level security;
alter table public.user_challenges enable row level security;

-- Profiles
create policy "profiles_select_all"  on public.profiles for select using (true);
create policy "profiles_insert_own"  on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own"  on public.profiles for update using (auth.uid() = id);

-- Jobs
create policy "jobs_select_all"  on public.jobs for select using (true);
create policy "jobs_insert_auth" on public.jobs for insert with check (auth.uid() = poster_id);
create policy "jobs_update_own"  on public.jobs for update using (auth.uid() = poster_id);
create policy "jobs_delete_own"  on public.jobs for delete using (auth.uid() = poster_id);

-- Slots
create policy "slots_select_all"   on public.job_slots for select using (true);
create policy "slots_insert_poster" on public.job_slots for insert with check (
  exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
);
create policy "slots_update_any"   on public.job_slots for update using (true);

-- Requirements
create policy "reqs_select_all"    on public.job_requirements for select using (true);
create policy "reqs_insert_poster" on public.job_requirements for insert with check (
  exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
);

-- Bookings
create policy "bookings_select_own"  on public.bookings for select using (auth.uid() = earner_id);
create policy "bookings_insert_own"  on public.bookings for insert with check (auth.uid() = earner_id);
create policy "bookings_update_own"  on public.bookings for update using (auth.uid() = earner_id);

-- Reviews
create policy "reviews_select_all"  on public.reviews for select using (true);
create policy "reviews_insert_auth" on public.reviews for insert with check (auth.uid() = reviewer_id);

-- Badges
create policy "badges_own" on public.badges for all using (auth.uid() = user_id);

-- Challenges
create policy "challenges_own" on public.user_challenges for all using (auth.uid() = user_id);

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, avatar_initial, member_since)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data->>'name', new.email), 1)),
    to_char(now(), 'Mon YYYY')
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- AUTO-UPDATE updated_at
-- ============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();
