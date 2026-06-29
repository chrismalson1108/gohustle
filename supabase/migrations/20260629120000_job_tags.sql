-- Job tags: free-form multi-tags on a gig beyond the single category
-- (e.g. "lawncare", "assembly", "heavy lifting"). Used for discovery,
-- search, and "For You" skill matching. Additive + safe for the live app
-- (existing code ignores the column; default keeps existing rows valid).
alter table public.jobs
  add column if not exists tags text[] not null default '{}';
