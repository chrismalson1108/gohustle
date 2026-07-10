-- ─────────────────────────────────────────────────────────────────────────────
-- Prerequisite DDL for the profile column-lockdown (ordered BEFORE
-- 20260624221000_profile_column_lockdown.sql).
--
-- Security-review finding `skill-rates-no-ddl-rebuild-abort`: profiles.skill_rates
-- and profiles.stripe_identity_session_id are referenced only in GRANT statements
-- and were added out-of-band on the live DB — they have no ADD COLUMN anywhere in
-- the repo. On a FRESH rebuild from tracked migrations, the column-lockdown's
-- `grant select ( ... skill_rates ... )` therefore throws "column does not exist"
-- and ABORTS, which stops the whole migration run — so the anon-SELECT revoke
-- (20260710020000) and every later hardening never apply, silently re-opening the
-- cross-user profile exposure (H4). This backfills the DDL so the lockdown (and
-- everything after it) applies cleanly on a rebuild.
--
-- Idempotent no-op on the live DB, where both columns already exist. NOTE: this file
-- carries an intentionally EARLY timestamp so it runs before the lockdown on a fresh
-- rebuild. If `supabase db push` reports it as out-of-order against the live history,
-- apply with `supabase db push --include-all` — it is a safe no-op live.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists skill_rates jsonb;
alter table public.profiles add column if not exists stripe_identity_session_id text;
