-- ─────────────────────────────────────────────────────────────────────────────
-- jobs.category_slug must be DERIVED, never accepted from a client (2026-08-05).
--
-- 20260805000000 bound the normalizer as:
--     BEFORE INSERT OR UPDATE OF category ON public.jobs
--
-- so an UPDATE that touches only `category_slug` never fires it, and
-- guard_jobs_write — which pins title/category/location/pay on a gig with a live
-- booking — does not mention category_slug at all. jobs RLS lets a poster update
-- their own row, so the identity column the entire taxonomy joins, filters, groups
-- and notifies on was directly writable and completely unvalidated.
--
-- Demonstrated on production inside a rolled-back transaction: a gig with
-- category 'Tech Help' / category_slug 'tech-help' accepted
--     update public.jobs set category_slug = 'totally-bogus-slug'
-- leaving the label and the identity pointing at different categories.
--
-- What that buys an attacker, all as an ordinary authenticated poster:
--   * point a gig at a popular category's slug while displaying another label, so
--     it surfaces under a chip and in saved-search alerts it does not belong to
--   * write a slug with no categories row, so the gig silently drops out of the
--     browse chip row and out of area_market_stats' mode()
--   * do either on a CONFIRMED/COMPLETED booking, which guard_jobs_write exists
--     specifically to prevent for every other core term
--
-- FIX: add category_slug to the trigger's column list. normalize_job_category
-- always re-derives the slug from new.category, so any write of either column now
-- lands on the derived value and a client-supplied slug is simply overwritten.
--
-- This also closes the booked-gig hole without touching guard_jobs_write: that
-- guard runs first (trg_g... sorts before trg_y...) and pins new.category back to
-- old.category, and the normalizer then derives the slug from that pinned label —
-- so a booked gig's identity follows its pinned category automatically.
--
-- The function body is unchanged; only the binding moves. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

drop trigger if exists trg_y_normalize_job_category on public.jobs;
create trigger trg_y_normalize_job_category
  before insert or update of category, category_slug on public.jobs
  for each row execute function public.normalize_job_category();

-- Any row whose slug does not match what the label derives to was either written
-- before this fix or through that gap. Re-derive them. The content guard is left
-- ARMED here: unlike 20260805000000's cosmetic label backfill this touches only
-- category_slug, which trg_guard_content_jobs is not bound to, so it does not fire.
update public.jobs j
set category_slug = public.resolve_category_slug(j.category)
where j.category_slug is distinct from public.resolve_category_slug(j.category);
