-- ─────────────────────────────────────────────────────────────────────────────
-- Certificates bucket: restrict to safe raster MIME types + size cap (2026-07-07).
--
-- Security audit finding (Medium): the public `certificates` bucket (added in
-- 20260629160000_certifications.sql) was never added to the allowed_mime_types /
-- file_size_limit allowlist that migration_security_hardening_2.sql applied to the
-- other public image buckets. As a result an authenticated user could store an
-- image/svg+xml or text/html object in their own certificates folder (directly via
-- the Storage REST API, bypassing the web client's re-encode) — active content that
-- EXECUTES on the *.supabase.co storage origin and is linked from their public
-- profile (rendered as <a href=…> in the cert strip). The bucket-level allowlist is
-- the only durable guard (client re-encoding is not — a direct API call sets its own
-- Content-Type), so we add certificates to the exact same raster allowlist + 10 MB
-- cap as the other public buckets. image/svg+xml and text/html can then never be
-- stored regardless of client. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

update storage.buckets
set allowed_mime_types = array['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','image/gif'],
    file_size_limit    = 10485760  -- 10 MB
where id = 'certificates';
