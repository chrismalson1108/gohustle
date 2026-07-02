-- ─────────────────────────────────────────────────────────────────────────────
-- Make chat-photos PRIVATE (DM images were world-readable + path-enumerable).
--
-- Before: the bucket was public with a `chat_photos_public_read` policy, and
-- messages.image_url stored a permanent public URL — anyone could view (or
-- enumerate) any user's DM images. Now the bucket is private and reads are
-- limited to the two parties of the booking the image belongs to; the apps
-- render images through short-lived signed URLs (createSignedUrl), which the
-- storage layer only issues to a caller who passes this SELECT policy.
--
-- Matching: going forward image_url stores the bare object path ("<uid>/<file>");
-- legacy rows store a full public URL ending in "/chat-photos/<uid>/<file>", so
-- both forms are matched. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

update storage.buckets set public = false where id = 'chat-photos';

-- Remove the world-readable policy.
drop policy if exists "chat_photos_public_read" on storage.objects;

-- Party-scoped read: the sender (owns the "<uid>/…" folder) OR the counterparty
-- on the booking that references this image. createSignedUrl succeeds only when
-- this passes, so non-parties can neither view nor enumerate chat images.
drop policy if exists "chat_photos_party_read" on storage.objects;
create policy "chat_photos_party_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-photos'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1
        from public.messages m
        join public.bookings b on b.id = m.booking_id
        join public.jobs j on j.id = b.job_id
        where (
                m.image_url = storage.objects.name
                or m.image_url like '%/chat-photos/' || storage.objects.name
              )
          and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
      )
    )
  );

-- Insert/delete remain sender-owned (unchanged from migration_job_chat_photos.sql,
-- re-declared here so a fresh DB built only from supabase/migrations/ is complete).
drop policy if exists "chat_photos_insert_own" on storage.objects;
create policy "chat_photos_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "chat_photos_delete_own" on storage.objects;
create policy "chat_photos_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-photos' and (storage.foldername(name))[1] = auth.uid()::text);
