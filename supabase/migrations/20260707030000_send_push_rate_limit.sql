-- ─────────────────────────────────────────────────────────────────────────────
-- send-push rate-limit table (2026-07-07). Idempotent.
--
-- Security audit finding (Low): the send-push edge function authenticates the
-- caller and enforces a strong anti-spoof gate (recipient must share a booking) +
-- content sanitization, but has NO rate limit. A user who shares even one booking
-- with a target can loop the endpoint to flood the target's push devices and their
-- persistent Alerts inbox (each call inserts a notifications row). This backs a
-- per-caller cap in send-push mirroring the assistant_rate pattern.
--
-- RLS enabled with NO client policies → only the service-role edge function can
-- read/write it; the anon/user client cannot see or tamper with counts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.push_send_rate (
  id         bigserial primary key,
  user_id    uuid        not null,
  created_at timestamptz not null default now()
);

create index if not exists push_send_rate_user_time
  on public.push_send_rate (user_id, created_at);

alter table public.push_send_rate enable row level security;
