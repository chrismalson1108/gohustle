-- ─────────────────────────────────────────────────────────────────────────────
-- H4 (profile-pii-cross-user) + H5 (jobs-anon-scrapable): revoke ANON read on the
-- student directory and the job feed (2026-07-10).
--
-- Before this, `profiles` (name, school, major, class year, city, photo) and `jobs`
-- (title, free-text location, ~1km coords, slot times) were readable by an
-- UNAUTHENTICATED caller holding the embedded anon key — the whole student base and
-- job feed were bulk-scrapable with no login, and the join composes into "which
-- identifiable young person is where, when." The row policies stay `USING(true)`;
-- what scopes cross-user visibility is the column/table GRANT, and it was granted to
-- `anon`. This revokes the anon grant entirely on both tables. `authenticated` keeps
-- its (already column-scoped, for profiles) grant, so every signed-in flow is
-- unchanged — only the pre-login/anon-key path is closed.
--
-- Safe for the web app: gohustlr.com's landing page is fully static (no pre-auth
-- profile/job fetch) and the (app) routes are auth-gated client components, so
-- nothing renders these tables as `anon`. Verify post-deploy with an anon-key curl:
--   curl "$SUPABASE_URL/rest/v1/profiles?select=name" -H "apikey: $ANON_KEY"   -> []/401
--   curl "$SUPABASE_URL/rest/v1/jobs?select=title"    -H "apikey: $ANON_KEY"   -> []/401
--
-- NOTE: this only revokes the anon PATH. Trimming the cross-user COLUMN set for
-- authenticated users (city/major/class_standing/grad_year/referral_code) is the
-- separate Medium follow-up in FABLE_SECURITY_PRIVACY_REVIEW §3.4 step 3.
-- ─────────────────────────────────────────────────────────────────────────────

revoke select on public.profiles from anon;
revoke select on public.jobs     from anon;
