-- ─────────────────────────────────────────────────────────────────────────────
-- Notifications inbox upgrade (idempotent). Run in the SQL editor.
--
-- Adds an Inbox/Archived split and a routing payload so EVERY app event (booking
-- requests, accepts/declines, completions, messages, gig matches) can flow into
-- the Alerts screen — handled/viewed ones get archived out of the inbox.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.notifications add column if not exists archived boolean not null default false;
alter table public.notifications add column if not exists data     jsonb;

-- Inbox query: a user's non-archived alerts, newest first.
create index if not exists idx_notifications_inbox on public.notifications(user_id, archived, created_at desc);
