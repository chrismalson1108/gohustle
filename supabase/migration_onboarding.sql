-- ============================================================
-- Migration: Onboarding + Auth Improvements
-- Run in Supabase SQL Editor after migration_messaging.sql
-- ============================================================

-- Add onboarding fields to profiles
alter table public.profiles
  add column if not exists username          text unique,
  add column if not exists bio               text,
  add column if not exists skills            text[] default '{}',
  add column if not exists radius_miles      int default 25,
  add column if not exists city              text,
  add column if not exists onboarding_done   boolean default false;

-- Username must be lowercase alphanumeric + underscores, 3-30 chars
alter table public.profiles
  add constraint username_format check (
    username is null or username ~ '^[a-z0-9_]{3,30}$'
  );

-- Index for fast username lookups (duplicate check)
create unique index if not exists profiles_username_unique
  on public.profiles (lower(username))
  where username is not null;

-- RLS: let users update their own profile (needed for onboarding)
drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile" on public.profiles
  for update using (id = auth.uid());

-- RLS: let users read any profile (needed for poster trust cards, messaging)
drop policy if exists "profiles are viewable by everyone" on public.profiles;
create policy "profiles are viewable by everyone" on public.profiles
  for select using (true);
