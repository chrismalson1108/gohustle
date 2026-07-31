-- ─────────────────────────────────────────────────────────────────────────────
-- Stop a bump from deleting the gig's exact address (2026-07-30).
--
-- 20260726090000 added a retraction branch to capture_job_location: if an incoming
-- label carries no exact detail, the stored exact_location is deleted, because a
-- poster editing their street address down to a city has plainly retracted it. That
-- reasoning is right. The trigger condition is not.
--
-- The same function rewrites `new.location := masked` whenever it captures an exact
-- address. So after the first write the jobs row holds a city-level label, and on any
-- subsequent UPDATE — bump, description edit, pay change, anything — NEW.location
-- carries that masked value unchanged. mask_location(masked) is masked, the else
-- branch fires, and the exact address is deleted.
--
-- Concretely: poster lists a gig at a street address, an earner books, the poster
-- accepts, the earner is now entitled to the exact location. The poster bumps the
-- listing to get more applicants. The address is gone — for a booking that is already
-- confirmed, on a platform where the whole point is turning up at the right place.
-- job_locations is the only store, so there is nothing to fall back to.
--
-- Fix is the same shape guard_job_pay_floor already uses ("Only when pay is being set
-- or changed"): do nothing unless the location is actually being set or changed. A
-- genuine retraction still deletes, because that write DOES change location.
--
-- Generated from 20260726090000 (the LATEST definition; 20260722040000 is superseded)
-- by scripted replacement and diffed: one guard added, capture and retraction logic
-- untouched. Idempotent.
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
  -- Only act when the location is actually being SET or CHANGED.
  --
  -- Without this the retraction branch below fires on every unrelated write. The
  -- first write rewrites new.location to its masked form, so from then on the row
  -- holds a city-level label — and on ANY later UPDATE (bumping the gig, editing the
  -- description, changing the pay) NEW.location carries that same masked value
  -- unchanged. mask_location(masked) is masked, so the else-branch reads it as "the
  -- poster has removed the street address" and deletes the stored exact_location.
  --
  -- The address the accepted earner needs in order to turn up is therefore destroyed
  -- by the most ordinary action a poster takes. Nothing about that write said
  -- anything about the location.
  if tg_op = 'UPDATE' and new.location is not distinct from old.location then
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
