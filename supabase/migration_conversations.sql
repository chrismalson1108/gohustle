-- Per-user conversation state for the Messages hub: last-read (for unread badges)
-- and archived flag. One row per (user, booking). Owner RLS. Idempotent.
create table if not exists public.conversation_state (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  booking_id   uuid not null references public.bookings(id) on delete cascade,
  last_read_at timestamptz,
  archived     boolean not null default false,
  primary key (user_id, booking_id)
);
alter table public.conversation_state enable row level security;
drop policy if exists "conv_state_select_own" on public.conversation_state;
create policy "conv_state_select_own" on public.conversation_state for select using (auth.uid() = user_id);
drop policy if exists "conv_state_insert_own" on public.conversation_state;
create policy "conv_state_insert_own" on public.conversation_state for insert with check (auth.uid() = user_id);
drop policy if exists "conv_state_update_own" on public.conversation_state;
create policy "conv_state_update_own" on public.conversation_state for update using (auth.uid() = user_id);
