-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (HIGH, privacy-pii): mask_location() failed OPEN on any label containing
-- the substring "remote" (2026-07-26).
--
-- 20260722040000 moved address masking server-side so a poster's exact street
-- address is only visible to the poster and an accepted earner. Both the SQL port
-- and its two client twins opened with:
--
--     if position('remote' in lower(loc)) > 0 then return loc; end if;
--
-- intended as "a remote gig has no physical address, so masking is pointless". But
-- it is a SUBSTRING test over the whole label, so any address that happens to
-- contain those six letters is published verbatim to every signed-in user.
-- Verified against the shipped client implementation:
--
--   "1234 Remote Ridge Rd, Dallas, TX"          -> returned UNMASKED
--   "123 Main St, Dallas, TX (remote possible)" -> returned UNMASKED
--
-- Neither is contrived: "Remote Ridge Rd" is an ordinary street name, and noting
-- "(remote possible)" on an otherwise physical gig is a natural thing for a poster
-- to type. The result is exactly what 20260722040000 set out to prevent — the
-- poster's home address readable by anyone with an account, before any booking.
--
-- The shortcut is also unnecessary. A "Remote" segment carries no digit and does not
-- end in a street/unit keyword, so the ordinary filter keeps it:
--     'Remote'             -> 'Remote'
--     'Remote, Dallas, TX' -> 'Remote, Dallas, TX'
-- Removing the branch is therefore strictly safer AND behaviour-preserving for
-- genuinely remote listings. Confirmed case-by-case against the JS implementation.
--
-- Backfill: rows written while the shortcut was live still hold an unmasked label in
-- jobs.location, and the capture trigger never stored an exact address for them
-- (it only captures when mask(x) <> x, which was false for these). Touching them
-- re-runs trg_mask_job_location, which now captures the exact value into
-- job_locations and masks the public column — same reversible path as the original
-- migration's backfill.
--
-- Only the "remote" branch changes; the segment logic below it is copied verbatim
-- from 20260722040000. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.mask_location(loc text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  seg  text;
  kept text[] := '{}';
begin
  if loc is null then return null; end if;
  -- NOTE: no "contains 'remote' -> return loc" shortcut. See the banner above: it
  -- matched inside real street addresses and published them in full. A genuine
  -- 'Remote' segment survives the filter below on its own.
  foreach seg in array string_to_array(loc, ',') loop
    seg := btrim(seg);
    if seg = '' then continue; end if;
    if seg ~ '\d' then continue; end if;  -- street lines carry a number
    -- ...or END with a spelled-out street/unit keyword ("Main Street", "Apt", "Ste").
    if seg ~* '\y(st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|dr|drive|ct|court|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway|trl|trail|apt|apartment|ste|suite|unit|fl|floor|rm|room)\y\.?$' then
      continue;
    end if;
    kept := array_append(kept, seg);
  end loop;
  if coalesce(array_length(kept, 1), 0) >= 1 then
    return array_to_string(kept, ', ');
  end if;
  return 'Nearby area';
end;
$$;

-- Re-mask every row that could have slipped through the old shortcut. The trigger
-- captures the exact label into job_locations before overwriting jobs.location, so
-- nothing is lost — the address stays available to the poster and accepted earners.
update public.jobs
   set location = location
 where location is not null
   and position('remote' in lower(location)) > 0;

-- Verify post-deploy:
--   select public.mask_location('1234 Remote Ridge Rd, Dallas, TX');  -- 'Dallas, TX'
--   select public.mask_location('123 Main St, Dallas, TX (remote possible)');
--                                                        -- 'Dallas, TX (remote possible)'
--   select public.mask_location('Remote');                -- 'Remote'
--   select public.mask_location('Remote, Dallas, TX');    -- 'Remote, Dallas, TX'
