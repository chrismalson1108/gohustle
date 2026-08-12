-- ─────────────────────────────────────────────────────────────────────────────
-- Admin roles: four tiers instead of two, plus a login throttle (2026-08-06).
--
-- WHAT WAS WRONG WITH TWO
--
-- 'support' could READ everything — every user's PII, every payment, every booking,
-- and the team roster — while being able to MUTATE almost nothing. That is least
-- privilege inverted: maximum exposure, minimum usefulness.
--
-- It also had a money consequence. resolveReport requires the 'admin' tier, and
-- earner-claim-payment refuses to settle a booking with an open report or dispute
-- (earner-claim-payment/index.ts). So a support person could see the queue that was
-- blocking a worker's pay and could not clear it — one person's availability was a
-- money-harm control.
--
-- THE FOUR TIERS, split by what someone is actually employed to do:
--
--   support  tickets, and a user's own context. NOT bulk PII, NOT all payments.
--   trust    moderation and disputes, WITH authority to resolve — because that
--            authority is what unblocks an earner's payout.
--   finance  payments, refunds, payout intervention, escrow.
--   admin    everything, plus team, flags, pricing and promotions.
--
-- Ranked, not orthogonal: admin ⊃ finance/trust ⊃ support. A flat capability matrix
-- is more precise but needs a permissions UI to stay honest, and an unmaintained
-- permissions UI drifts into everyone-is-admin. Ranks are checkable in one line.
--
-- NOTHING IS SILENTLY WIDENED. The existing single admin keeps 'admin'. There are no
-- other admin_users rows, so nobody gains or loses access from this migration — it
-- creates the vocabulary, and the console enforces it.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users
  add constraint admin_users_role_check
  check (role in ('admin', 'finance', 'trust', 'support'));

comment on column public.admin_users.role is
  'Ranked tier: admin > finance/trust > support. finance = money surfaces; '
  'trust = moderation + disputes with resolve authority; support = tickets and a '
  'user''s own context.';

-- ── Login throttle ───────────────────────────────────────────────────────────
-- The console had no lockout: an attacker who obtained an admin email could grind
-- passwords indefinitely, with only TOTP behind it. MFA is a strong second factor,
-- but letting the first factor be brute-forced for free is still a gift — and the
-- attempt log is itself the signal that someone is trying.
create table if not exists public.admin_login_attempts (
  id         bigint generated always as identity primary key,
  email      text not null,
  ip         text,
  ok         boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_login_attempts_email_idx
  on public.admin_login_attempts (lower(email), created_at desc);
create index if not exists admin_login_attempts_ip_idx
  on public.admin_login_attempts (ip, created_at desc);

alter table public.admin_login_attempts enable row level security;
revoke all on public.admin_login_attempts from anon, authenticated;
grant all on public.admin_login_attempts to service_role;

-- Locked out when EITHER the account or the source IP is over its budget. Per-email
-- alone lets one attacker spray many accounts from one host; per-IP alone lets a
-- botnet grind one account. Both, or neither works.
create or replace function public.admin_login_blocked(p_email text, p_ip text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    (select count(*) from public.admin_login_attempts
      where lower(email) = lower(coalesce(p_email, ''))
        and not ok and created_at > now() - interval '15 minutes') >= 5
    or
    (select count(*) from public.admin_login_attempts
      where p_ip is not null and ip = p_ip
        and not ok and created_at > now() - interval '15 minutes') >= 20
$$;

create or replace function public.record_admin_login(p_email text, p_ip text, p_ok boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.admin_login_attempts (email, ip, ok) values (p_email, p_ip, p_ok);
$$;

revoke execute on function public.admin_login_blocked(text, text) from public, anon, authenticated;
revoke execute on function public.record_admin_login(text, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_login_blocked(text, text) to service_role;
grant execute on function public.record_admin_login(text, text, boolean) to service_role;

-- ── Controls for the console's own security posture ──────────────────────────
create or replace function public.ctl_admin_login_bruteforce()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select lower(email),
         jsonb_build_object(
           'failed_attempts', count(*),
           'window', '1 hour',
           'distinct_ips', count(distinct ip))
    from public.admin_login_attempts
   where not ok and created_at > now() - interval '1 hour'
   group by lower(email)
  having count(*) >= 10
$$;

revoke execute on function public.ctl_admin_login_bruteforce() from public, anon, authenticated;

-- An admin account without MFA enrolled is the whole chain's weak link: requireAdmin
-- demands AAL2, so such an account cannot sign in at all — it is either a
-- half-finished invite or an account someone is locked out of. Either way, someone
-- should know rather than discover it during an incident.
create or replace function public.ctl_admin_without_mfa()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select a.user_id::text,
         jsonb_build_object('role', a.role, 'status', a.status,
                            'created_at', a.created_at, 'mfa_enrolled_at', a.mfa_enrolled_at)
    from public.admin_users a
   where a.status = 'active' and a.mfa_enrolled_at is null
$$;

revoke execute on function public.ctl_admin_without_mfa() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('admin_login_bruteforce',
   'Admin account under sustained failed-login pressure',
   'high', 'security',
   'Ten or more failed console logins for one account in an hour. The throttle blocks '
   'at 5 per 15 minutes, so this is someone still trying after being told no — worth '
   'a human looking, because the console holds the service-role key.',
   'ctl_admin_login_bruteforce'),
  ('admin_without_mfa',
   'Active admin account with no MFA enrolled',
   'high', 'security',
   'requireAdmin demands AAL2, so this account cannot actually sign in. It is either a '
   'half-finished invite or someone locked out — and either way it is a standing '
   'credential nobody is watching.',
   'ctl_admin_without_mfa')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
