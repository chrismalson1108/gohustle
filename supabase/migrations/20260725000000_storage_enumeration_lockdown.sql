-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (HIGH, privacy-pii): stop ANONYMOUS enumeration of the `avatars` and
-- `job-photos` buckets (2026-07-25).
--
-- Verified against production with nothing but the embedded anon key and no
-- account at all:
--   POST /storage/v1/object/list/avatars  {"prefix":"","limit":100}
--     -> 200, one folder per user UUID that has ever uploaded a profile photo
--   POST /storage/v1/object/list/avatars  {"prefix":"<uuid>/"}
--     -> 200, the exact object filename
--   GET  /storage/v1/object/public/avatars/<uuid>/<file>.jpg
--     -> 200 image/jpeg, the full photo
-- i.e. the whole user base — user ids paired with face photos — is bulk
-- harvestable with no login. `job-photos` carries the identical policy and is
-- only empty today because of the pre-launch data reset; at beta scale it would
-- expose poster ids plus photos of the homes/property where the work happens.
--
-- Root cause: on storage.objects a single SELECT policy governs BOTH downloading
-- and LISTING, and these two were written unrestricted —
--     create policy "avatars_public_read" on storage.objects
--       for select using (bucket_id = 'avatars');          -- migration_profile_photos.sql:12
--     create policy "job_photos_public_read" on storage.objects
--       for select using (bucket_id = 'job-photos');       -- migration_job_chat_photos.sql:13
-- With no `to` clause the policy also applies to `anon`, which turns "avatars are
-- publicly viewable" into "the object index is publicly walkable".
--
-- This is the same defect class already fixed for the three sibling buckets —
-- receipts (migration_receipts_private.sql), chat-photos (20260701000000) and
-- completion-photos (20260707010000, whose banner names the exact risk:
-- "world-readable and path-enumerable via getPublicUrl"). `avatars` and
-- `job-photos` were simply never swept, so this also finishes the job the H4/H5
-- anon-revocation migrations (20260710020000, 20260715030000) set out to do:
-- those revoked anon SELECT on `profiles`/`jobs` to stop bulk scraping of a
-- minor-inclusive user base, but the storage index re-opened the same door and
-- did not even require the profiles row to walk it.
--
-- Fix: scope the SELECT policy to the owner's own folder. This removes the LIST
-- primitive for anon AND for other signed-in users, while leaving rendering
-- completely untouched:
--   * Both buckets stay `public = true`, and Supabase serves public buckets over
--     /object/public/<bucket>/<path> WITHOUT evaluating RLS — which is exactly
--     how every avatar and job photo is rendered today (getPublicUrl in
--     src/lib/uploadImage.js:110 and web/lib/uploadImage.ts:48).
--   * No client anywhere calls storage .list() (verified across src/, web/ and
--     admin/), so nothing depends on the enumeration this removes.
--   * Upload/replace/delete are unaffected — they run through the separate
--     *_insert_own / *_update_own / *_delete_own policies, which already pin the
--     first path segment to auth.uid().
--
-- Residual (accepted, and it is the product): a signed-in user can still fetch
-- the avatar of a profile they are allowed to read, because they get the URL
-- from profiles.avatar_url. What is closed is the unauthenticated bulk harvest —
-- object paths carry a random component, so without LIST they are not guessable,
-- and `profiles` is already anon-revoked (verified: /rest/v1/profiles -> 401).
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- avatars: owner-scoped listing only. Public rendering is unaffected (see above).
drop policy if exists "avatars_public_read" on storage.objects;
drop policy if exists "avatars_owner_list" on storage.objects;
create policy "avatars_owner_list" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- job-photos: same treatment. Same rendering path, same absence of any .list()
-- caller, so the change is invisible to the apps.
drop policy if exists "job_photos_public_read" on storage.objects;
drop policy if exists "job_photos_owner_list" on storage.objects;
create policy "job_photos_owner_list" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'job-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- certificates: same defect, and the most sensitive of the three — this bucket
-- holds uploaded credential documents (licence/certification scans, via
-- src/lib/certifications.js:27 and web/lib/certifications.ts:50). Empty today only
-- because of the pre-launch reset. 20260707020000_certificates_mime_allowlist.sql
-- already hardened uploads to this bucket but left the read side wide open; this
-- closes it. Also rendered via getPublicUrl, so rendering is unaffected.
drop policy if exists "certificates_public_read" on storage.objects;
drop policy if exists "certificates_owner_list" on storage.objects;
create policy "certificates_owner_list" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'certificates'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Verify post-deploy — each of these must now return an empty list for anon:
--   curl -X POST "$SUPABASE_URL/storage/v1/object/list/avatars" \
--     -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
--     -d '{"prefix":"","limit":100}'                      -> []
--   curl -X POST "$SUPABASE_URL/storage/v1/object/list/job-photos" \
--     -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
--     -d '{"prefix":"","limit":100}'                      -> []
-- while a known public URL must still render:
--   curl -I "$SUPABASE_URL/storage/v1/object/public/avatars/<uid>/<file>.jpg" -> 200
