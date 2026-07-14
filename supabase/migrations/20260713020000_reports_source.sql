-- Distinguish automated moderation reports (e.g. an auto-blocked image) from
-- human user reports in the admin Moderation queue. Additive, defaults to
-- 'user' so every existing row and all user-submitted reports are unaffected.
-- Written by the service role (moderate-image edge function).
alter table public.reports add column if not exists source text not null default 'user';
