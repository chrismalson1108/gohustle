-- Favorites: save people you've worked with (re-hire / re-book quickly). Owner RLS.
create table if not exists public.favorites (
  user_id          uuid not null references public.profiles(id) on delete cascade,
  favorite_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at       timestamptz default now(),
  primary key (user_id, favorite_user_id)
);
alter table public.favorites enable row level security;
drop policy if exists "favorites_select_own" on public.favorites;
create policy "favorites_select_own" on public.favorites for select using (auth.uid() = user_id);
drop policy if exists "favorites_insert_own" on public.favorites;
create policy "favorites_insert_own" on public.favorites for insert with check (auth.uid() = user_id);
drop policy if exists "favorites_delete_own" on public.favorites;
create policy "favorites_delete_own" on public.favorites for delete using (auth.uid() = user_id);
