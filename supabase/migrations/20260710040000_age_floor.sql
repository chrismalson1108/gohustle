-- ─────────────────────────────────────────────────────────────────────────────
-- H7 (no-age-verification): minimum age floor of 18, enforced server-side at action
-- time (2026-07-10).
--
-- Before this, the only control was a self-attested "I'm 18" checkbox — no DOB was
-- collected and the backend never learned the user's age, so a minor could browse,
-- post, message, book, and disclose location. This adds a nullable date_of_birth
-- column and a guard trigger that hard-blocks a KNOWN under-18 from the three
-- in-person-meeting-arranging actions: posting a gig, booking a gig, and messaging.
--
-- Sequencing (per FABLE_FIX_PLAN trap #4): the column is NULLABLE and the guard only
-- blocks when a DOB is present and < 18 — so existing testers (no DOB yet) are not
-- bricked. New users must enter a valid 18+ DOB at onboarding (client), and existing
-- users backfill it (Settings). Once the cohort is fully backfilled, tighten to block
-- NULL too. This is a minimum age FLOOR (self-attested DOB), not full identity
-- verification. Service role bypasses.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists date_of_birth date;

create or replace function public.guard_min_age()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dob date;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  select date_of_birth into dob from public.profiles where id = auth.uid();
  -- Only hard-block a KNOWN minor (dob present). NULL = not yet collected → allowed,
  -- so we don't brick existing users; the client collection funnel populates it.
  if dob is not null and dob > (current_date - interval '18 years') then
    raise exception 'You must be 18 or older to do this on GoHustlr.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Trigger functions must not be directly callable by clients.
revoke execute on function public.guard_min_age() from public, anon, authenticated;

drop trigger if exists trg_min_age_jobs on public.jobs;
create trigger trg_min_age_jobs
  before insert on public.jobs
  for each row execute function public.guard_min_age();

drop trigger if exists trg_min_age_bookings on public.bookings;
create trigger trg_min_age_bookings
  before insert on public.bookings
  for each row execute function public.guard_min_age();

drop trigger if exists trg_min_age_messages on public.messages;
create trigger trg_min_age_messages
  before insert on public.messages
  for each row execute function public.guard_min_age();
