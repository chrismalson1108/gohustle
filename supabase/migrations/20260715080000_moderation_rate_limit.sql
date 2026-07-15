-- ─────────────────────────────────────────────────────────────────────────────
-- moderation rate-limit ledger (2026-07-15). Idempotent.
--
-- Backs a per-user request cap in the moderate-text / moderate-image edge functions
-- so a scripted loop can't run up unbounded Anthropic API cost / Storage egress and
-- trip the fail-open moderation branch (deep-audit finding). Mirrors the existing
-- assistant_rate / push_send_rate pattern exactly.
--
-- RLS is enabled with NO client policies → only the service-role edge functions can
-- read/write it; the anon/user client cannot see or tamper with counts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.moderation_rate (
  id         bigserial primary key,
  user_id    uuid        not null,
  created_at timestamptz not null default now()
);

create index if not exists moderation_rate_user_time
  on public.moderation_rate (user_id, created_at);

alter table public.moderation_rate enable row level security;
