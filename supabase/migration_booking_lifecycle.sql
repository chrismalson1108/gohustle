-- ============================================================
-- Migration: Booking Lifecycle
-- Run this in Supabase SQL Editor after the initial schema.sql
-- ============================================================

-- Add lifecycle columns to bookings
alter table public.bookings
  add column if not exists payment_method     text,
  add column if not exists earner_rating      numeric(2,1),
  add column if not exists review_text        text,
  add column if not exists completed_at       timestamptz;

-- Expand status enum to include 'verified' and 'declined'
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('pending','confirmed','completed','verified','declined','cancelled'));

-- Allow posters to SELECT bookings on their jobs
drop policy if exists "bookings_poster_view" on public.bookings;
create policy "bookings_poster_view" on public.bookings for select using (
  auth.uid() = earner_id
  or exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
);

-- Allow both earner AND poster to UPDATE a booking
drop policy if exists "bookings_select_own" on public.bookings;
create policy "bookings_select_own" on public.bookings for select using (
  auth.uid() = earner_id
  or exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
);

drop policy if exists "bookings_update_own" on public.bookings;
create policy "bookings_update_own" on public.bookings for update using (
  auth.uid() = earner_id
  or exists (select 1 from public.jobs where id = job_id and poster_id = auth.uid())
);

-- Enable realtime for bookings table
drop publication if exists supabase_realtime;
create publication supabase_realtime for table public.bookings, public.jobs;
