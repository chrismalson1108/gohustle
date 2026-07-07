-- ─────────────────────────────────────────────────────────────────────────────
-- Make completion-photos PRIVATE (2026-07-07).
--
-- Before: the bucket was public, so proof-of-work photos — often interiors of a
-- client's home — were world-readable and path-enumerable via getPublicUrl. Now
-- the bucket is private and reads are limited to the two parties of the booking
-- the photo belongs to; the apps render via short-lived signed URLs
-- (createSignedUrl), which storage only issues to a caller who passes this policy.
-- Mirrors the chat-photos hardening (20260701000000_private_chat_photos.sql).
--
-- Matching: going forward the app stores the bare object path ("<uid>/<file>");
-- legacy rows store a full public URL ending in "/completion-photos/<uid>/<file>".
-- Both forms are matched, across bookings.completion_photos AND before_photos.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

update storage.buckets set public = false where id = 'completion-photos';

-- Remove the world-readable policy.
drop policy if exists "completion_public_read" on storage.objects;

-- Party-scoped read: the uploader (owns the "<uid>/…" folder) OR either party of a
-- booking that references this object in its completion/before photo arrays.
drop policy if exists "completion_party_read" on storage.objects;
create policy "completion_party_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'completion-photos'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1
        from public.bookings b
        join public.jobs j on j.id = b.job_id
        cross join lateral unnest(
          coalesce(b.completion_photos, '{}'::text[]) || coalesce(b.before_photos, '{}'::text[])
        ) as photo(val)
        where (b.earner_id = auth.uid() or j.poster_id = auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
    )
  );

-- Insert/delete remain uploader-owned (re-declared so a fresh DB is complete).
drop policy if exists "completion_insert_own" on storage.objects;
create policy "completion_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'completion-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "completion_delete_own" on storage.objects;
create policy "completion_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'completion-photos' and (storage.foldername(name))[1] = auth.uid()::text);
