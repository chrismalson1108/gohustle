-- ─────────────────────────────────────────────────────────────────────────────
-- Opt-in availability display on the public profile, for logged-in viewers only.
--
-- The profile column lockdown (20260624221000_profile_column_lockdown.sql) does
-- NOT grant `availability` to anyone except the owner (via my_profile()) and the
-- service role. This migration adds an opt-in flag `show_availability` (default
-- OFF = private) and grants SELECT on BOTH `availability` and `show_availability`
-- to `authenticated` ONLY — never to `anon`. So a worker's weekly availability is
-- visible to signed-in viewers when (a) the owner opted in, or (b) the viewer is
-- the owner. Anonymous visitors can never read either column (PostgREST would fail
-- the whole query), which is exactly why the public-profile main select stays
-- unchanged and the availability columns are fetched by a separate, gated query.
--
-- `authenticated` may also UPDATE `show_availability` on their own row (RLS still
-- scopes which row). Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists show_availability boolean not null default false;

-- availability is readable only by logged-in users (NOT anon); the opt-in flag too:
grant select (availability, show_availability) on public.profiles to authenticated;
grant update (show_availability) on public.profiles to authenticated;
