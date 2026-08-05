-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill profiles.recent_category_slugs from existing job history (2026-08-05).
--
-- 20260805000000 added the column and the AFTER INSERT trigger that maintains it,
-- but only for gigs posted FROM THAT POINT ON. Every existing poster therefore had
-- an empty array, so the "your recent categories" quick chips in the post/edit
-- pickers — the whole "the category is saved for them" behaviour — showed nothing
-- until their next post. Caught on the simulator: a poster with four gigs behind
-- them saw no chips at all.
--
-- Most-recent-first, deduped by slug, capped at 8 — the same shape and cap the
-- trigger maintains, so a row backfilled here is indistinguishable from one built
-- up by posting.
--
-- Only touches profiles that are still empty, which makes this idempotent and means
-- re-running it can never clobber recents a user has accumulated since.
-- ─────────────────────────────────────────────────────────────────────────────

with latest as (
  -- One row per (poster, category): the most recent time they used it.
  select poster_id, category_slug, max(created_at) as last_used
  from public.jobs
  where category_slug is not null
    and poster_id is not null
  group by poster_id, category_slug
),
ordered as (
  select
    poster_id,
    category_slug,
    row_number() over (partition by poster_id order by last_used desc, category_slug) as rn
  from latest
)
update public.profiles p
set recent_category_slugs = sub.slugs
from (
  select poster_id, array_agg(category_slug order by rn) as slugs
  from ordered
  where rn <= 8
  group by poster_id
) sub
where p.id = sub.poster_id
  and p.recent_category_slugs = '{}';
