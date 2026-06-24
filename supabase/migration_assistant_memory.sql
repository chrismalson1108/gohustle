-- ─────────────────────────────────────────────────────────────────────────────
-- Hustlr AI — coach memory (idempotent, additive). Run in the SQL editor.
--
-- A small set of durable facts the assistant remembers about the user across
-- conversations (goals, preferences, context) — e.g. "saving for spring break",
-- "prefers weekend gigs", "no delivery jobs". Kept compact and injected into the
-- prompt, so cross-chat continuity costs almost nothing (no transcript replay).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists assistant_memory jsonb not null default '[]';
