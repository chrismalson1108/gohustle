-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill profiles.recent_category_slugs — for real this time (2026-08-05).
--
-- 20260805010000 ran clean and changed NOTHING. guard_profiles_write ends with
-- `return old;`: the owner branch is gated on `auth.uid() = old.id`, and a migration
-- has no auth.uid() and is not service_role, so every row fell through to the
-- catch-all and the entire UPDATE was discarded. No error, no warning — the exact
-- silent-revert shape as the guard_jobs_write bug this same change fixed in
-- EditJobScreen, which is a decent argument that the shape is worth watching for.
--
-- The guard already has the sanctioned escape hatch for server-side recomputation:
--   if current_setting('app.recompute', true) = 'on' then return new; end if;
--
-- It is set inside a DO block rather than with a bare `SET LOCAL`, because the CLI
-- does not guarantee an open transaction around a migration file — a bare SET LOCAL
-- warns "can only be used in transaction blocks" and silently does nothing, which
-- would make this file a no-op again on a fresh rebuild. A DO block always has a
-- transaction context, and set_config(..., is_local => true) unsets at its end, so
-- the bypass cannot leak past this statement.
--
-- WHY the backfill matters: 20260805000000 added the column and the AFTER INSERT
-- trigger that maintains it, but only for gigs posted from that point on. Every
-- existing poster had an empty array, so the "your recent categories" quick chips —
-- the whole "the category is saved for them" behaviour — showed nothing until their
-- next post. Caught on the simulator.
--
-- Most-recent-first, deduped by slug, capped at 8: the same shape and cap the trigger
-- maintains, so a backfilled row is indistinguishable from one built up by posting.
-- Only touches profiles still empty, so it is idempotent and can never clobber
-- recents accumulated since.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  perform set_config('app.recompute', 'on', true);

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
end $$;
