-- ─────────────────────────────────────────────────────────────────────────────
-- Admin team lifecycle + closing the MFA trust-on-first-use window (2026-08-04).
--
-- TWO PROBLEMS, ONE SHAPE.
--
-- (1) admin_users has only (user_id, role, created_by, created_at) and is seeded by
--     hand in the SQL editor. Nobody can add a support helper, change a role, or
--     revoke a departing teammate without Supabase database credentials — exactly
--     the wrong dependency for an offboarding, and the console deliberately refuses
--     to act on a fellow admin (users/[id]/actions.ts assertActionableTarget).
--
-- (2) Trust-on-first-use MFA. app/mfa/page.tsx auto-enrolls a fresh TOTP factor for
--     whoever presents valid credentials when the account has no verified factor,
--     and requireAdmin only asks whether the JWT says aal2. README's setup order
--     seeds the admin_users row (step 2) BEFORE the person enrolls (step 3), so
--     every new admin has a window in which a password-only compromise — the same
--     shared consumer auth pool the mobile app uses, so credential stuffing applies
--     — yields a fully-enrolled attacker with the service-role console. That console
--     now issues refunds.
--
-- The fix for both is a membership STATUS. A row created from the console is inert
-- ('pending') until an existing admin activates it, which they do AFTER the person
-- has enrolled and confirmed the factor out of band. An attacker who wins the
-- password race can enroll, but their row is still pending and requireAdmin refuses.
--
-- Existing rows are backfilled 'active' so nobody is locked out by this migration.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.admin_users add column if not exists status text not null default 'active';
alter table public.admin_users add column if not exists mfa_factor_id text;
alter table public.admin_users add column if not exists mfa_enrolled_at timestamptz;
alter table public.admin_users add column if not exists disabled_at timestamptz;
alter table public.admin_users add column if not exists note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'admin_users_status_check') then
    alter table public.admin_users add constraint admin_users_status_check
      check (status in ('pending', 'active', 'disabled'));
  end if;
end $$;

-- Belt and braces: anything that existed before this migration was already working,
-- so it stays working.
update public.admin_users set status = 'active' where status is null;

comment on column public.admin_users.status is
  'pending = added but not yet activated; the guard refuses. active = full access. '
  'disabled = revoked, row kept for audit attribution.';


-- Who may be listed/counted without handing the console raw table access. Returns
-- the email alongside the membership so /team can show a person, not a uuid.
create or replace function public.admin_team_list()
returns table (
  user_id         uuid,
  email           text,
  name            text,
  role            text,
  status          text,
  mfa_enrolled_at timestamptz,
  created_at      timestamptz,
  disabled_at     timestamptz,
  note            text
)
language sql
security definer
stable
set search_path = public
as $$
  select a.user_id, u.email::text, p.name, a.role, a.status,
         a.mfa_enrolled_at, a.created_at, a.disabled_at, a.note
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
   order by (a.status = 'active') desc, a.created_at
$$;

revoke execute on function public.admin_team_list() from public, anon, authenticated;
grant execute on function public.admin_team_list() to service_role;


-- Resolve an existing account by email so the console can grant access without the
-- operator hunting a uuid in the Supabase dashboard. Returns null when no account
-- exists — an admin must have signed up through the normal app first, which is
-- deliberate: this grants access to an account, it does not create one.
create or replace function public.admin_find_user_id(p_email text)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1
$$;

revoke execute on function public.admin_find_user_id(text) from public, anon, authenticated;
grant execute on function public.admin_find_user_id(text) to service_role;


-- Record the factor the moment an admin enrolls, so /team can show an existing
-- admin WHAT to approve and WHEN it appeared. Called from the MFA page's verify
-- step. Deliberately does NOT activate anything — activation stays a human decision
-- by a different human, which is the entire point.
create or replace function public.admin_record_mfa_enrollment(p_factor_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.admin_users
     set mfa_factor_id = p_factor_id,
         mfa_enrolled_at = coalesce(mfa_enrolled_at, now())
   where user_id = auth.uid()
     and (mfa_factor_id is distinct from p_factor_id or mfa_enrolled_at is null);
end;
$$;

-- Callable by the enrolling user themselves (auth.uid() scopes it to their own row,
-- and it can only ever write these two columns).
revoke execute on function public.admin_record_mfa_enrollment(text) from public, anon;
grant execute on function public.admin_record_mfa_enrollment(text) to authenticated, service_role;


-- Never let the console strand itself. Counts admins who can actually sign in.
create or replace function public.admin_active_admin_count()
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::integer from public.admin_users where role = 'admin' and status = 'active'
$$;

revoke execute on function public.admin_active_admin_count() from public, anon, authenticated;
grant execute on function public.admin_active_admin_count() to service_role;
