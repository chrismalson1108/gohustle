-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 5 — #7 + #18. Make the owner-private profile column lockdown
-- part of the TRACKED migration path (it previously lived only in the loose
-- standalone migration_security_hardening_6.sql, which the documented deploy steps
-- never ran — so a fresh/rebuilt DB exposed assistant_memory, school_domain,
-- availability, monthly/weekly earning goals, work_status_note, and
-- stripe_identity_session_id to any authenticated client).
--
-- This grant is the source of truth going forward. Compared with hardening_6 it
-- ALSO drops earnings_today/week/total (already revoked in round 2) and the private
-- goal columns (weekly_earning_goal, weekly_jobs_goal) from the public set (#18).
-- The owner reads their own full row via my_profile() (SECURITY DEFINER); service
-- role bypasses column grants. profiles_select_all USING(true) stays — the column
-- grant, not the row policy, is what scopes which columns are visible cross-user.
-- ─────────────────────────────────────────────────────────────────────────────

revoke select on public.profiles from anon, authenticated;
grant select (
  id, name, avatar_initial, role, rating, review_count, verified, member_since, xp,
  streak_days, weekly_jobs_done, created_at, updated_at, username, bio, skills,
  radius_miles, city, onboarding_done, poster_rating, poster_review_count, avatar_url,
  terms_accepted_at, terms_version, skill_rates, referral_code, id_verification_status,
  id_verification_requested_at, school, major, degree_type, class_standing, grad_year,
  student_status, student_verified, student_verified_at, student_verify_method, work_status
) on public.profiles to anon, authenticated;

-- Owner self-read (all columns) — unchanged, included so a fresh DB has it too.
create or replace function public.my_profile()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select to_jsonb(p) from public.profiles p where p.id = auth.uid()
$$;

revoke execute on function public.my_profile() from public;
grant execute on function public.my_profile() to authenticated;
