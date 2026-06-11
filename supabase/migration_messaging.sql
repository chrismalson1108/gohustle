-- ============================================================
-- Migration: Messaging
-- Run in Supabase SQL Editor after migration_booking_lifecycle.sql
-- ============================================================

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid references public.bookings(id) on delete cascade not null,
  sender_id   uuid references public.profiles(id) not null,
  text        text not null,
  created_at  timestamptz default now()
);

alter table public.messages enable row level security;

-- Both earner and poster of the booking can read messages
create policy "messages_read" on public.messages for select using (
  exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id
    and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
  )
);

-- Both can send messages
create policy "messages_insert" on public.messages for insert with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id
    and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
  )
);

-- Add messages to realtime publication
alter publication supabase_realtime add table public.messages;
