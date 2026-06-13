-- Business expense tracking for tax filing. Owner-only RLS. Receipt images go in
-- a public "receipts" bucket under "<auth.uid()>/..." (unguessable paths).
-- Idempotent.

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      numeric(10,2) not null,
  category    text not null,
  description text,
  date        date not null default current_date,
  receipt_url text,
  created_at  timestamptz default now()
);

create index if not exists expenses_user_date_idx on public.expenses (user_id, date desc);

alter table public.expenses enable row level security;

drop policy if exists "expenses_select_own" on public.expenses;
create policy "expenses_select_own" on public.expenses for select using (auth.uid() = user_id);
drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own" on public.expenses for insert with check (auth.uid() = user_id);
drop policy if exists "expenses_update_own" on public.expenses;
create policy "expenses_update_own" on public.expenses for update using (auth.uid() = user_id);
drop policy if exists "expenses_delete_own" on public.expenses;
create policy "expenses_delete_own" on public.expenses for delete using (auth.uid() = user_id);

-- receipts bucket
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', true)
on conflict (id) do nothing;

drop policy if exists "receipts_public_read" on storage.objects;
create policy "receipts_public_read" on storage.objects
  for select using (bucket_id = 'receipts');

drop policy if exists "receipts_insert_own" on storage.objects;
create policy "receipts_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "receipts_delete_own" on storage.objects;
create policy "receipts_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
