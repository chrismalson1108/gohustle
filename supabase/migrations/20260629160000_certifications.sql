-- Trade-school certifications / credentials on profiles (e.g. "EPA 608
-- Certification", issuer "Trade Tech", year 2024, optional image). Public read so
-- they show on the public profile; owner-only insert/delete. Idempotent + safe on
-- the live DB. Mirrors the favorites table RLS + the avatars public bucket policies.
create table if not exists public.certifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  issuer     text,
  year       int,
  image_url  text,
  created_at timestamptz default now()
);
create index if not exists certifications_user_id_idx on public.certifications (user_id);

alter table public.certifications enable row level security;
drop policy if exists "certifications_public_read" on public.certifications;
create policy "certifications_public_read" on public.certifications for select using (true);
drop policy if exists "certifications_insert_own" on public.certifications;
create policy "certifications_insert_own" on public.certifications for insert with check (auth.uid() = user_id);
drop policy if exists "certifications_delete_own" on public.certifications;
create policy "certifications_delete_own" on public.certifications for delete using (auth.uid() = user_id);

-- Public bucket so certificate image URLs render without signed requests.
insert into storage.buckets (id, name, public)
values ('certificates', 'certificates', true)
on conflict (id) do nothing;

drop policy if exists "certificates_public_read" on storage.objects;
create policy "certificates_public_read" on storage.objects
  for select using (bucket_id = 'certificates');

drop policy if exists "certificates_insert_own" on storage.objects;
create policy "certificates_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'certificates' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "certificates_update_own" on storage.objects;
create policy "certificates_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'certificates' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "certificates_delete_own" on storage.objects;
create policy "certificates_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'certificates' and (storage.foldername(name))[1] = auth.uid()::text);
