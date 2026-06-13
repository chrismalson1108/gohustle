-- Images for job postings (jobs.photos) and chat messages (messages.image_url),
-- with public buckets and owner-scoped write RLS. Idempotent.

alter table public.jobs     add column if not exists photos text[] default '{}';
alter table public.messages add column if not exists image_url text;

-- job-photos: poster writes under "<auth.uid()>/...", everyone reads.
insert into storage.buckets (id, name, public)
values ('job-photos', 'job-photos', true)
on conflict (id) do nothing;

drop policy if exists "job_photos_public_read" on storage.objects;
create policy "job_photos_public_read" on storage.objects
  for select using (bucket_id = 'job-photos');

drop policy if exists "job_photos_insert_own" on storage.objects;
create policy "job_photos_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "job_photos_delete_own" on storage.objects;
create policy "job_photos_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- chat-photos: sender writes under "<auth.uid()>/...", everyone reads.
insert into storage.buckets (id, name, public)
values ('chat-photos', 'chat-photos', true)
on conflict (id) do nothing;

drop policy if exists "chat_photos_public_read" on storage.objects;
create policy "chat_photos_public_read" on storage.objects
  for select using (bucket_id = 'chat-photos');

drop policy if exists "chat_photos_insert_own" on storage.objects;
create policy "chat_photos_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "chat_photos_delete_own" on storage.objects;
create policy "chat_photos_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-photos' and (storage.foldername(name))[1] = auth.uid()::text);
