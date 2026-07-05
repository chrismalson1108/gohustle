-- ─────────────────────────────────────────────────────────────────────────────
-- Admin console v2 — ops dashboard, moderation, payments/disputes, support system,
-- and login-IP surfacing. All new tables/RPCs are service-role-only (the console's
-- server runtime is the sole caller); production RLS for the user apps is untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Support tickets ──────────────────────────────────────────────────────────
-- Filed by the public Contact form (via the support-submit edge fn, service role)
-- and answered from the console. Service-role only; the user apps never read these.
create table if not exists public.support_tickets (
  id              bigint generated always as identity primary key,
  user_id         uuid references public.profiles(id) on delete set null,
  email           text not null,
  name            text,
  subject         text not null,
  category        text,
  status          text not null default 'open' check (status in ('open','pending','closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;
create index if not exists support_tickets_status_idx on public.support_tickets (status, last_message_at desc);
create index if not exists support_tickets_email_idx  on public.support_tickets (email);

create table if not exists public.support_ticket_messages (
  id         bigint generated always as identity primary key,
  ticket_id  bigint not null references public.support_tickets(id) on delete cascade,
  author     text not null check (author in ('user','admin')),
  admin_id   uuid,               -- who replied (no FK: attribution outlives accounts)
  body       text not null,
  created_at timestamptz not null default now()
);
alter table public.support_ticket_messages enable row level security;
revoke all on public.support_ticket_messages from anon, authenticated;
create index if not exists support_ticket_messages_ticket_idx
  on public.support_ticket_messages (ticket_id, created_at);

-- ── Ops dashboard metrics ────────────────────────────────────────────────────
-- One round-trip for the whole home page instead of ~20 separate count queries.
create or replace function public.admin_dashboard_metrics()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'users_total',        (select count(*) from public.profiles),
    'signups_today',      (select count(*) from public.profiles where created_at >= date_trunc('day', now())),
    'signups_7d',         (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
    'signups_30d',        (select count(*) from public.profiles where created_at >= now() - interval '30 days'),
    'suspended_users',    (select count(*) from public.profiles where suspended_at is not null),
    'jobs_open',          (select count(*) from public.jobs where status = 'open'),
    'jobs_total',         (select count(*) from public.jobs),
    'bookings_pending',   (select count(*) from public.bookings where status = 'pending'),
    'bookings_confirmed', (select count(*) from public.bookings where status = 'confirmed'),
    'bookings_completed', (select count(*) from public.bookings where status = 'completed'),
    'bookings_verified',  (select count(*) from public.bookings where status = 'verified'),
    'gmv_captured_cents', (select coalesce(sum(amount_cents), 0) from public.payments where status = 'captured'),
    'fees_captured_cents',(select coalesce(sum(fee_cents), 0)    from public.payments where status = 'captured'),
    'escrow_held_cents',  (select coalesce(sum(amount_cents), 0) from public.payments where status = 'authorized'),
    'disputes_total',     (select count(*) from public.disputes),
    'disputes_7d',        (select count(*) from public.disputes where created_at >= now() - interval '7 days'),
    'reports_total',      (select count(*) from public.reports),
    'reports_7d',         (select count(*) from public.reports where created_at >= now() - interval '7 days')
  )
$$;
revoke execute on function public.admin_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to service_role;

-- ── Login-IP history (surface, don't newly track) ───────────────────────────
-- Reads the login/auth events Supabase Auth ALREADY records in
-- auth.audit_log_entries — no new IP collection anywhere in the user apps.
-- plpgsql so body validation defers to call time (schema-tolerant across
-- Supabase versions). service-role only.
create or replace function public.admin_user_login_history(target uuid, lim int default 25)
returns table (created_at timestamptz, ip text, action text)
language plpgsql
security definer
stable
set search_path = auth, public
as $$
begin
  return query
    select e.created_at,
           coalesce(nullif(e.ip_address::text, ''), e.payload->>'ip_address') as ip,
           e.payload->>'action' as action
    from auth.audit_log_entries e
    where e.payload->>'actor_id' = target::text
    order by e.created_at desc
    limit lim;
end
$$;
revoke execute on function public.admin_user_login_history(uuid, int) from public, anon, authenticated;
grant execute on function public.admin_user_login_history(uuid, int) to service_role;
