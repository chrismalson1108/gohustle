-- Two-sided reviews: tag each review with the role the reviewed person played.
-- 'earner' = reviewed for work performed; 'poster' = reviewed as a client/employer.
-- Existing reviews were all earner-side. Idempotent.

alter table public.reviews add column if not exists role text not null default 'earner';
update public.reviews set role = 'earner' where role is null;
create index if not exists reviews_reviewed_user_idx on public.reviews (reviewed_user_id);
