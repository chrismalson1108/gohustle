-- Defense-in-depth: slots_update_poster (authoritative def in
-- 20260624230000_review6_db_fixes.sql) is USING-only — it gates which existing
-- job_slots rows a poster may touch, but has NO WITH CHECK, so the POST-update row is
-- unvalidated. A poster could reassign a slot's job_id to a job they own OR (worse) the
-- USING clause alone does not stop the new row from pointing at a job whose ownership
-- isn't re-verified. Add a matching WITH CHECK so ownership is enforced on BOTH sides of
-- the update: the slot's job must be owned by the caller before AND after.
--
-- Strictly non-weakening: the USING predicate is preserved unchanged and a WITH CHECK
-- with the same ownership predicate is added. Idempotent via DROP POLICY IF EXISTS.

drop policy if exists "slots_update_poster" on public.job_slots;
create policy "slots_update_poster" on public.job_slots for update
  using (
    exists (select 1 from public.jobs j where j.id = job_slots.job_id and j.poster_id = auth.uid())
  )
  with check (
    exists (select 1 from public.jobs j where j.id = job_slots.job_id and j.poster_id = auth.uid())
  );
