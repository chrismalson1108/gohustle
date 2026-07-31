-- ─────────────────────────────────────────────────────────────────────────────
-- Correction to 20260730170000: never touch OLD outside an UPDATE (2026-07-30).
--
-- 20260730170000 guarded the retraction with:
--     if tg_op = 'UPDATE' and new.location is not distinct from old.location
-- which is correct ONLY if the AND short-circuits. PostgreSQL does not guarantee
-- evaluation order of AND operands, and OLD is null for an INSERT trigger, so on an
-- unlucky plan a gig INSERT could error on the OLD reference — breaking gig posting
-- outright, which is far worse than the address bug it was fixing.
--
-- Every other guard in this schema sidesteps this by putting the INSERT case FIRST in
-- an OR (guard_job_pay_floor: `if tg_op = 'INSERT' or new.pay is distinct from
-- old.pay`). Here the equivalent is a nested if, so OLD is only ever read inside the
-- UPDATE branch. Behaviour is otherwise identical to 20260730170000.
--
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
  if tg_op = 'UPDATE' then
    if new.location is not distinct from old.location then
      return new;
    end if;
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
