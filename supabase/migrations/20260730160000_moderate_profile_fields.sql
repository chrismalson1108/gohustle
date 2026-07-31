-- ─────────────────────────────────────────────────────────────────────────────
-- Moderation backstop: cover the rest of the public profile (2026-07-30).
--
-- 20260730130000 closed jobs.location, the free-text field on a gig that nothing
-- filtered. The same sweep found the profile equivalents, and they are the same
-- shape: user-authored free text rendered to other people, checked by nothing.
--
--   * profiles.city   — shown on the public profile and used as a location signal
--   * profiles.school — shown on the public profile ("University of X")
--   * profiles.major  — shown on the public profile ("Electrical Engineering")
--   * profiles.skills — a text[] the earner types, rendered as chips on the public
--                       profile and matched against gigs
--
-- The guard already covered name, username, bio and work_status_note on this table,
-- which is what makes the omission worth closing rather than arguing about: an
-- attacker blocked from putting a slur in their bio could put it in their major, and
-- it renders two lines below on the same card. skills is the one that matters most —
-- it is an array, so it never even looked like a single text field to check.
--
-- array_to_string mirrors how jobs.tags and jobs.hazards are already handled.
--
-- Generated from 20260730130000 (the LATEST definition) by scripted replacement and
-- diffed: four checks added, nothing removed, service_role bypass intact. Existing
-- rows are untouched; the guard fires on write. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_prohibited_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role (admin console / system writes) bypasses; user content is guarded
  -- on the user-facing insert/update paths. PRESERVED VERBATIM from 20260715070000 —
  -- dropping it would subject admin-console and edge-function writes to the filter.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if TG_TABLE_NAME = 'jobs' then
    if public.contains_prohibited(new.title)
       or public.contains_prohibited(new.description)
       or public.contains_prohibited(new.category)
       or public.contains_prohibited(new.location)
       or public.contains_prohibited(array_to_string(new.tags, ' '))
       or public.contains_prohibited(array_to_string(new.hazards, ' ')) then
      raise exception 'This post contains content that is not allowed on GoHustlr.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'messages' then
    if public.contains_prohibited(new.text) then
      raise exception 'This message contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'reviews' then
    if public.contains_prohibited(new.text) then
      raise exception 'This review contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'profiles' then
    -- name/username added: the display name renders on essentially every surface,
    -- and username additionally appears in search and @-mentions.
    if public.contains_prohibited(new.bio)
       or public.contains_prohibited(new.work_status_note)
       or public.contains_prohibited(new.name)
       or public.contains_prohibited(new.username)
       or public.contains_prohibited(new.city)
       or public.contains_prohibited(new.school)
       or public.contains_prohibited(new.major)
       or public.contains_prohibited(array_to_string(new.skills, ' ')) then
      raise exception 'Your profile contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'bookings' then
    -- slot_label added: earner-authored free text that renders to the poster.
    if public.contains_prohibited(new.application_note)
       or public.contains_prohibited(new.review_text)
       or public.contains_prohibited(new.poster_review)
       or public.contains_prohibited(new.amendment_note)
       or public.contains_prohibited(new.slot_label) then
      raise exception 'Your note contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'job_requirements' then
    if public.contains_prohibited(new.requirement) then
      raise exception 'This requirement contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'job_slots' then
    if public.contains_prohibited(new.label) then
      raise exception 'This schedule label contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'certifications' then
    if public.contains_prohibited(new.title) or public.contains_prohibited(new.issuer) then
      raise exception 'This certification contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
