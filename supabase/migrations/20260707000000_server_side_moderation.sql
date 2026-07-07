-- ─────────────────────────────────────────────────────────────────────────────
-- Server-side content moderation backstop (2026-07-07).
--
-- The client filter (shared/contentFilter.js `findProhibited`) is the first line +
-- the UX, but it can be bypassed by calling PostgREST directly with the anon key +
-- a valid JWT. This adds a DB-level enforcement so prohibited content can NEVER be
-- written to the user-facing free-text fields, regardless of client.
--
-- KEEP THE TERM LIST IN SYNC with shared/contentFilter.js's BLOCKED array. The
-- whole-word, case-insensitive matching mirrors findProhibited's boundary regex.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.contains_prohibited(txt text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  term  text;
  low   text := lower(coalesce(txt, ''));
  terms text[] := array[
    -- slurs / hate
    'nigger','faggot','retard','kike','spic','chink',
    -- explicit sexual solicitation
    'escort','prostitute','sexual favor','sexual favors','nudes','onlyfans',
    -- obvious illegal / scam
    'cocaine','meth','heroin','launder','money laundering','stolen goods'
  ];
begin
  if low = '' then
    return false;
  end if;
  foreach term in array terms loop
    -- (^|[^a-z])term([^a-z]|$) — same word boundary as the client filter. Terms are
    -- lowercase letters + spaces only, so no regex-escaping is needed.
    if low ~ ('(^|[^a-z])' || term || '([^a-z]|$)') then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

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
    if public.contains_prohibited(new.title) or public.contains_prohibited(new.description) then
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
    if public.contains_prohibited(new.application_note) then
      raise exception 'Your note contains content that is not allowed.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- Trigger functions must not be directly callable by clients.
revoke execute on function public.guard_prohibited_content() from public, anon, authenticated;

drop trigger if exists trg_guard_content_jobs on public.jobs;
create trigger trg_guard_content_jobs
  before insert or update of title, description on public.jobs
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_messages on public.messages;
create trigger trg_guard_content_messages
  before insert or update of text on public.messages
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_reviews on public.reviews;
create trigger trg_guard_content_reviews
  before insert or update of text on public.reviews
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_profiles on public.profiles;
create trigger trg_guard_content_profiles
  before insert or update of bio, work_status_note on public.profiles
  for each row execute function public.guard_prohibited_content();

drop trigger if exists trg_guard_content_bookings on public.bookings;
create trigger trg_guard_content_bookings
  before insert or update of application_note on public.bookings
  for each row execute function public.guard_prohibited_content();
