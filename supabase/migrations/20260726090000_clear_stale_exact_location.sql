-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM, privacy-pii): a removed street address was still served
-- (2026-07-26).
--
-- capture_job_location() (20260722040000) stores the poster's exact label in
-- job_locations and writes the masked form to jobs.location. It only does so when the
-- incoming label actually carries exact detail:
--
--     if masked is distinct from new.location then
--        insert ... on conflict (job_id) do update set exact_location = ...
--        new.location := masked;
--     end if;
--
-- That guard is correct for its original purpose — it stops a guard-reverted or
-- already-masked value from clobbering the stored exact address. But it also means
-- the ELSE case does nothing at all: when a poster EDITS a gig and replaces
-- "123 Main St, Dallas, TX" with a city-level "Dallas, TX", masked == new.location,
-- the branch is skipped, and job_locations keeps the OLD street address indefinitely.
--
-- job_locations is readable by the poster and any earner with a confirmed+ booking, so
-- the address the poster deliberately removed keeps being served to them. The poster
-- has every reason to believe they retracted it — the public column visibly changed.
-- Deleting the gig is safe (ON DELETE CASCADE removes the row); it is specifically
-- editing the address down to a city that leaves the old one behind.
--
-- Fix: make the else-branch explicit instead of a no-op. When the incoming label
-- carries NO exact detail, the poster is telling us there is no exact address for this
-- gig any more, so any stored one is deleted. The two cases the original guard was
-- protecting against are unaffected, because both are handled before this point:
--   * a guard-reverted value is identical to what is already stored, so mask(x) <> x
--     still holds and we take the capture branch as before;
--   * an already-masked value arriving on a gig that never had an exact address simply
--     deletes nothing.
--
-- Backfill: drop rows whose stored exact_location no longer carries exact detail
-- (mask(exact) = exact) — those are already city-level and hold nothing worth keeping.
-- Rows where the public column has since been masked down to something that no longer
-- corresponds are left alone; only the poster can retract an address, and this
-- migration must not silently discard one that is still current.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.capture_job_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  masked text;
begin
  -- Defense-in-depth: snap coords to ~1.1km server-side too (clients already do).
  if new.lat is not null then new.lat := round(new.lat::numeric, 2); end if;
  if new.lng is not null then new.lng := round(new.lng::numeric, 2); end if;

  if new.location is null or btrim(new.location) = '' then
    return new;
  end if;
  masked := public.mask_location(new.location);
  if masked is distinct from new.location then
    -- Incoming label carries exact detail: capture it, publish the masked form.
    insert into public.job_locations (job_id, exact_location, updated_at)
    values (new.id, new.location, now())
    on conflict (job_id) do update set exact_location = excluded.exact_location, updated_at = now();
    new.location := masked;
  else
    -- Incoming label carries NO exact detail. Previously a no-op, which meant a poster
    -- editing their street address down to a city left the old exact address stored and
    -- still readable by the poster and accepted earners. Treat it as the retraction it
    -- plainly is.
    delete from public.job_locations where job_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.capture_job_location() from public, anon, authenticated;

-- Backfill: any stored exact_location that is already city-level holds nothing worth
-- keeping (and cannot be the "exact" address it claims to be).
delete from public.job_locations
 where exact_location is null
    or public.mask_location(exact_location) is not distinct from exact_location;

-- Verify post-deploy:
--   1. post a gig at "123 Main St, Dallas, TX" -> job_locations has the exact label
--   2. edit the same gig to "Dallas, TX"       -> the job_locations row is gone
--   3. edit it back to a street address        -> captured again
