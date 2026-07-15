-- ─────────────────────────────────────────────────────────────────────────────
-- Finish the H4/H5 anon-read revocation (2026-07-15).
--
-- 20260710020000_revoke_anon_public_read.sql revoked the anon SELECT grant on ONLY
-- public.profiles and public.jobs. Four sibling tables kept both a permissive
-- USING(true) SELECT policy AND the default Supabase anon table grant, so an
-- unauthenticated caller with the embedded anon key can still bulk-scrape them via
-- /rest/v1:
--   * reviews         — free-text review bodies, ratings, reviewer/reviewed UUIDs
--   * certifications   — user_id + credential title/issuer/year + image_url
--   * job_slots        — schedule labels + starts_at + job_id
--   * job_requirements — free-text requirements + job_id
-- This partially defeats the migration's own stated goal of closing anonymous PII
-- scraping of a minor-inclusive student base. Revoke the anon grant on all four; the
-- authenticated grants (which every signed-in app flow uses) are untouched, so only
-- the pre-login/anon-key path is closed.
--
-- Verify post-deploy with an anon-key curl (each should return []/401):
--   curl "$SUPABASE_URL/rest/v1/reviews?select=text"          -H "apikey: $ANON_KEY"
--   curl "$SUPABASE_URL/rest/v1/certifications?select=title"  -H "apikey: $ANON_KEY"
--   curl "$SUPABASE_URL/rest/v1/job_slots?select=label"       -H "apikey: $ANON_KEY"
--   curl "$SUPABASE_URL/rest/v1/job_requirements?select=requirement" -H "apikey: $ANON_KEY"
-- ─────────────────────────────────────────────────────────────────────────────

revoke select on public.reviews          from anon;
revoke select on public.certifications   from anon;
revoke select on public.job_slots        from anon;
revoke select on public.job_requirements from anon;
