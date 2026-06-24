-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 6 (idempotent). Run in the Supabase SQL editor.
--
-- #13: profiles_select_all (using true) exposed owner-private columns to ANY
-- authenticated caller via a direct PostgREST read (assistant_memory, the AI's
-- personal notes; monthly_earning_goal; work_status_note; availability;
-- school_domain; stripe_identity_session_id). The app never reads these
-- cross-user — only the owner's own profile load and service-role edge functions
-- touch them — so we lock them at the column-privilege level:
--   • Replace the table-wide SELECT grant with a column SELECT grant on the 43
--     PUBLIC columns only. Cross-user reads (poster cards, reviews, embeds) all
--     select public columns, so they're unaffected; an attacker can no longer
--     SELECT the 6 private columns for another user.
--   • my_profile() (SECURITY DEFINER) returns the CALLER's own full row, so the
--     owner's profile load still gets every column. Clients + the assistant read
--     their own profile through this RPC instead of select('*').
--   • Writes are unchanged: UPDATE privilege is untouched, and the app's profile
--     writes don't use a RETURNING/select, so they need no SELECT on these cols.
--   • Service-role edge functions bypass column grants entirely.
-- ─────────────────────────────────────────────────────────────────────────────

-- Lock SELECT to the public columns only (drops the implicit all-columns grant).
revoke select on public.profiles from anon, authenticated;
grant select (
  id, name, avatar_initial, role, rating, review_count, verified, member_since, xp,
  streak_days, earnings_today, earnings_week, earnings_total, weekly_earning_goal,
  weekly_jobs_goal, weekly_jobs_done, created_at, updated_at, username, bio, skills,
  radius_miles, city, onboarding_done, poster_rating, poster_review_count, avatar_url,
  terms_accepted_at, terms_version, skill_rates, referral_code, id_verification_status,
  id_verification_requested_at, school, major, degree_type, class_standing, grad_year,
  student_status, student_verified, student_verified_at, student_verify_method, work_status
) on public.profiles to anon, authenticated;

-- Owner self-read: returns the caller's OWN full row (all columns), bypassing the
-- column grant via SECURITY DEFINER. Only signed-in users; scoped to auth.uid().
create or replace function public.my_profile()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select to_jsonb(p) from public.profiles p where p.id = auth.uid()
$$;

revoke execute on function public.my_profile() from anon;
grant execute on function public.my_profile() to authenticated;
