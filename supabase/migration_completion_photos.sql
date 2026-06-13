-- Job-completion photos: array column on bookings + public "completion-photos"
-- bucket (proof-of-work images; URLs are unguessable). Earner writes under their
-- own "<auth.uid()>/..." path; everyone can read. Idempotent.

alter table public.bookings add column if not exists completion_photos text[] default '{}';

insert into storage.buckets (id, name, public)
values ('completion-photos', 'completion-photos', true)
on conflict (id) do nothing;

drop policy if exists "completion_public_read" on storage.objects;
create policy "completion_public_read" on storage.objects
  for select using (bucket_id = 'completion-photos');

drop policy if exists "completion_insert_own" on storage.objects;
create policy "completion_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'completion-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "completion_delete_own" on storage.objects;
create policy "completion_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'completion-photos' and (storage.foldername(name))[1] = auth.uid()::text);
