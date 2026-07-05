-- ─────────────────────────────────────────────────────────────────────────────
-- Admin console (v1: user support & accounts) — backing schema.
--
-- Access model: the admin Next.js app (admin/) talks to these tables ONLY through
-- its server runtime with the service-role key. All three tables have RLS enabled
-- with NO policies and all client grants revoked → invisible and inert to anon/
-- authenticated (same pattern as student_email_verifications). No admin RLS
-- policies exist anywhere, so the user-facing apps cannot grow an admin path.
--
-- Bootstrap the first admin manually in the SQL editor (uuid from auth.users):
--   insert into public.admin_users (user_id, role) values ('<uuid>', 'admin');
-- ─────────────────────────────────────────────────────────────────────────────

-- Who may use the admin console, and at what tier.
-- 'admin' = full (mutations); 'support' = read-only. Enforced in admin/lib/guard.ts.
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin', 'support')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

-- Append-only trail of every admin mutation and sensitive read (who/what/target/ip).
-- UPDATE/DELETE revoked from service_role too: privilege checks apply even though
-- service_role bypasses RLS, so rows are immutable to the console itself. (The
-- postgres superuser via the dashboard can still correct rows — acceptable.)
create table if not exists public.admin_audit_log (
  id          bigint generated always as identity primary key,
  admin_id    uuid not null references auth.users(id),
  action      text not null,
  target_type text,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;
revoke update, delete on public.admin_audit_log from anon, authenticated, service_role;
create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_target_idx  on public.admin_audit_log (target_type, target_id);
create index if not exists admin_audit_log_admin_idx   on public.admin_audit_log (admin_id);

-- Internal support notes about a user. Never user-visible.
create table if not exists public.admin_user_notes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  admin_id   uuid not null references auth.users(id),
  note       text not null,
  created_at timestamptz not null default now()
);
alter table public.admin_user_notes enable row level security;
revoke all on public.admin_user_notes from anon, authenticated;
create index if not exists admin_user_notes_user_idx on public.admin_user_notes (user_id, created_at desc);

-- Suspension display state. The enforcement is auth.users.banned_until (set via the
-- GoTrue admin API — blocks sign-in and token refresh); these columns exist so the
-- console can show/filter suspension state and a future in-app "account suspended"
-- screen can explain itself (owner sees them via my_profile(); the column-scoped
-- SELECT/UPDATE grants on profiles never expose them to other clients).
alter table public.profiles add column if not exists suspended_at timestamptz;
alter table public.profiles add column if not exists suspension_reason text;

-- Console user search. auth.users isn't exposed through PostgREST (only the public
-- schema is), so email lookup needs a SECURITY DEFINER hop. service_role-only.
create or replace function public.admin_find_users(q text)
returns table (
  id            uuid,
  email         text,
  name          text,
  username      text,
  created_at    timestamptz,
  suspended_at  timestamptz,
  verified      boolean,
  rating        numeric,
  review_count  integer
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, u.email::text, p.name, p.username, p.created_at,
         p.suspended_at, p.verified, p.rating, p.review_count
  from public.profiles p
  join auth.users u on u.id = p.id
  where u.email ilike '%' || q || '%'
     or p.username ilike '%' || q || '%'
     or p.name ilike '%' || q || '%'
     or p.id::text = lower(q)
  order by p.created_at desc
  limit 25
$$;

revoke execute on function public.admin_find_users(text) from public, anon, authenticated;
grant execute on function public.admin_find_users(text) to service_role;
