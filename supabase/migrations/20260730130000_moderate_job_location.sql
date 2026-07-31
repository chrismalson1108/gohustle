-- ─────────────────────────────────────────────────────────────────────────────
-- Moderation backstop: cover jobs.location (2026-07-30).
--
-- Every user-authored string that reaches another user's screen is meant to pass
-- public.contains_prohibited. jobs.location was the one that never did — at ANY
-- layer:
--
--   * PostJobScreen's keyword pass covers title, description, tags and hazards
--     (PostJobScreen.js:119) — not location.
--   * its moderateText call sends only title + description (PostJobScreen.js:127).
--   * this DB guard checked title/description/category/tags/hazards — not location.
--
-- And it is genuinely free text, not a constrained picker. LocationPicker is an
-- autocomplete over ~60 cities, but handleChange calls onChange(text, null) on
-- every keystroke (LocationPicker.js:58-60), so whatever is typed is what gets
-- submitted; matching a suggestion is optional. The column is plain `text not
-- null` with no CHECK (schema.sql:36).
--
-- It renders to everyone: the Browse card, the gig detail header, the location
-- filter chips, and the Market Insights area rollup. So it is a free slot for a
-- slur or for off-platform contact details ("call me 555-0100") shown to every
-- student browsing, while the fields on either side of it are filtered.
--
-- The DB is the layer a patched client cannot skip, so it is the one that counts;
-- the client-side additions are worth doing too but are not the control.
--
-- Generated from 20260726010000 (the LATEST definition of this function —
-- 20260707000000 and 20260715070000 are superseded) by scripted replacement, and
-- diffed: one line added, nothing removed. The service_role bypass at the top is
-- preserved verbatim — dropping it would subject every admin-console and
-- edge-function write to the content filter.
--
-- Existing rows are untouched; the guard fires on write. Idempotent.
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
       or public.contains_prohibited(new.username) then
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
