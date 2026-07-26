-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (HIGH, moderation bypass): cover profiles.name / profiles.username and
-- bookings.slot_label with the server-side content backstop (2026-07-26).
--
-- guard_prohibited_content is the DB backstop that makes moderation non-bypassable:
-- the clients filter before writing, but a user can always PATCH /rest/v1/... with
-- their own token, so the trigger is what actually enforces it. Its coverage was
-- extended twice (20260707000000, then 20260715070000) and still misses three
-- writable free-text fields:
--
--   * profiles.name      — the display name. This is the single most-rendered piece
--                          of user text in the product: every job card, booking row,
--                          chat header, review, public profile and push notification.
--                          The trigger fires only `of bio, work_status_note`, so a
--                          slur set as a display name is stored and shown everywhere.
--   * profiles.username   — same, and it additionally appears in @-mentions and
--                          search results (FindPeople).
--   * bookings.slot_label — free text the earner writes onto the booking at book
--                          time and which renders to the poster in My Jobs / Hiring.
--                          The bookings trigger covers application_note, review_text,
--                          poster_review and amendment_note but not this one, leaving
--                          an unmoderated earner -> poster channel.
--
-- The mobile client already runs both layers over name/username/bio
-- (src/screens/SettingsScreen.js:239-252, added for App Store Guideline 1.2) — but
-- the web profile editor runs NO filter at all, and neither client can be trusted as
-- the enforcement point anyway. This puts all three fields behind the same backstop
-- as every other UGC surface.
--
-- Only the trigger column lists and the two predicate branches change; the matching
-- function public.contains_prohibited (and its evasion normalisation) is untouched.
-- Idempotent.
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

revoke execute on function public.guard_prohibited_content() from public, anon, authenticated;

-- Re-point the two triggers whose column lists were too narrow. The others
-- (jobs, messages, reviews, job_requirements, job_slots, certifications) are
-- unchanged and are left alone.
drop trigger if exists trg_guard_content_profiles on public.profiles;
create trigger trg_guard_content_profiles
  before insert or update of bio, work_status_note, name, username on public.profiles
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_bookings on public.bookings;
create trigger trg_guard_content_bookings
  before insert or update of application_note, review_text, poster_review, amendment_note, slot_label
  on public.bookings
  for each row execute function public.guard_prohibited_content();

-- Verify post-deploy (each should be rejected with check_violation):
--   PATCH /rest/v1/profiles?id=eq.<self> {"name":"<slur>"}
--   PATCH /rest/v1/profiles?id=eq.<self> {"username":"<slur>"}
--   POST  /rest/v1/bookings {... "slot_label":"<slur>" ...}
-- ...and an ordinary name/username/slot_label must still save normally.
