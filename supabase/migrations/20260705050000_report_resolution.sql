-- Let the moderation queue track which reports have been handled. Additive,
-- nullable columns written ONLY by the console (service role). The reports table
-- has no UPDATE policy for anon/authenticated, so users can't touch these; RLS
-- (reporter-only select/insert) is unchanged.
alter table public.reports add column if not exists resolved_at  timestamptz;
alter table public.reports add column if not exists resolved_by  uuid;
alter table public.reports add column if not exists resolution   text;
create index if not exists reports_open_idx on public.reports (created_at desc) where resolved_at is null;
