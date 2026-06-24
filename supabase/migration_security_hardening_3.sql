-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 3 (idempotent). Run in the Supabase SQL editor.
--   1. job_slots — UPDATE policy was `using (true)`: any user could flip any
--      slot's `taken` flag (griefing / double-book). Now only the job's poster
--      or a user who has actually booked that job may update its slots.
--   2. jobs.lat/lng — backfill existing rows to a ~1km grid so previously-posted
--      gigs don't keep exposing a poster's exact coordinates publicly (new posts
--      are already coarsened on write).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. job_slots: only the poster or a booker of the job may change its slots -----
drop policy if exists "slots_update_any"   on public.job_slots;
drop policy if exists "slots_update_party" on public.job_slots;
create policy "slots_update_party" on public.job_slots for update using (
  exists (select 1 from public.jobs j     where j.id = job_slots.job_id and j.poster_id = auth.uid())
  or exists (select 1 from public.bookings b where b.job_id = job_slots.job_id and b.earner_id = auth.uid())
);

-- 2. Coarsen any precise coordinates already stored on public listings ---------
update public.jobs set lat = round(lat::numeric, 2) where lat is not null;
update public.jobs set lng = round(lng::numeric, 2) where lng is not null;
