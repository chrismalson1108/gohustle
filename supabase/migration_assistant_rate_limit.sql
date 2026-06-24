-- ─────────────────────────────────────────────────────────────────────────────
-- Hustlr AI rate-limit table (idempotent). Run in the Supabase SQL editor.
-- Backs a per-user request cap in the `assistant` edge function so a scripted
-- loop can't run up unbounded Anthropic API cost (deep-audit high finding).
-- RLS is enabled with NO client policies → only the service-role edge function
-- can read/write it; the anon/user client cannot see or tamper with counts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.assistant_rate (
  id         bigserial primary key,
  user_id    uuid        not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_rate_user_time
  on public.assistant_rate (user_id, created_at);

alter table public.assistant_rate enable row level security;
