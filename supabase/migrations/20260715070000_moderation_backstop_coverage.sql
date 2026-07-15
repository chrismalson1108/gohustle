-- ─────────────────────────────────────────────────────────────────────────────
-- Extend the server-side moderation backstop to the text fields it skipped
-- (2026-07-15).
--
-- guard_prohibited_content (20260707000000) only guarded jobs(title,description),
-- messages(text), reviews(text), profiles(bio,work_status_note) and
-- bookings(application_note). Several publicly-rendered free-text fields had NO
-- server backstop, so a direct-PostgREST write could persist prohibited content:
--   * jobs.category, jobs.tags, jobs.hazards      (client filters these; DB did not)
--   * bookings.review_text / poster_review        (rendered in history/profiles)
--   * bookings.amendment_note                      (had NO layer at all — a clean
--       counterparty side channel for exactly the solicited content the filters target)
--   * job_requirements.requirement                 (no trigger)
--   * job_slots.label                              (no trigger)
--   * certifications.title / issuer                (rendered on public profiles)
--
-- This recreates guard_prohibited_content with branches for the added tables/columns
-- and (re)binds the triggers. Enum-ish values (category) and short labels are still
-- only rejected when they contain a prohibited term, so legitimate values pass.
-- Service role bypasses (unchanged). The client-side amendment-note filter on the
-- proposeAmendment paths is owned by the mobile/web agents — see crossGroupNeeds.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_prohibited_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role (admin console / system writes) bypasses; user content is guarded
  -- on the user-facing insert/update paths.
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
    if public.contains_prohibited(new.bio) or public.contains_prohibited(new.work_status_note) then
      raise exception 'Your profile contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  elsif TG_TABLE_NAME = 'bookings' then
    if public.contains_prohibited(new.application_note)
       or public.contains_prohibited(new.review_text)
       or public.contains_prohibited(new.poster_review)
       or public.contains_prohibited(new.amendment_note) then
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

-- Trigger functions must not be directly callable by clients.
revoke execute on function public.guard_prohibited_content() from public, anon, authenticated;

-- jobs: add category/tags/hazards to the guarded columns.
drop trigger if exists trg_guard_content_jobs on public.jobs;
create trigger trg_guard_content_jobs
  before insert or update of title, description, category, tags, hazards on public.jobs
  for each row execute function public.guard_prohibited_content();

-- bookings: add review_text/poster_review/amendment_note.
drop trigger if exists trg_guard_content_bookings on public.bookings;
create trigger trg_guard_content_bookings
  before insert or update of application_note, review_text, poster_review, amendment_note on public.bookings
  for each row execute function public.guard_prohibited_content();

-- New coverage: job_requirements, job_slots, certifications.
drop trigger if exists trg_guard_content_job_requirements on public.job_requirements;
create trigger trg_guard_content_job_requirements
  before insert or update of requirement on public.job_requirements
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_job_slots on public.job_slots;
create trigger trg_guard_content_job_slots
  before insert or update of label on public.job_slots
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_certifications on public.certifications;
create trigger trg_guard_content_certifications
  before insert or update of title, issuer on public.certifications
  for each row execute function public.guard_prohibited_content();
