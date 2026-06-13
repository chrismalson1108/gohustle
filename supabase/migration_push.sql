-- Push notifications: per-user Expo push tokens. Owner-scoped RLS; the send-push
-- edge function reads tokens with the service role (bypasses RLS). Idempotent.

create table if not exists public.push_tokens (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  token      text not null,
  platform   text,
  updated_at timestamptz default now(),
  primary key (user_id, token)
);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens_select_own" on public.push_tokens;
create policy "push_tokens_select_own" on public.push_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "push_tokens_insert_own" on public.push_tokens;
create policy "push_tokens_insert_own" on public.push_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists "push_tokens_update_own" on public.push_tokens;
create policy "push_tokens_update_own" on public.push_tokens
  for update using (auth.uid() = user_id);

drop policy if exists "push_tokens_delete_own" on public.push_tokens;
create policy "push_tokens_delete_own" on public.push_tokens
  for delete using (auth.uid() = user_id);
