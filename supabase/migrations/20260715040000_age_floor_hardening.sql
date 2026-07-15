-- ─────────────────────────────────────────────────────────────────────────────
-- H7 age-floor hardening for open beta (2026-07-15).
--
-- The age floor (20260710040000) had three holes that open signups
-- (20260710070000_open_beta_signups) reopened:
--   (1) guard_profiles_write is a denylist that never pinned date_of_birth or
--       onboarding_done, so an owner could PATCH onboarding_done=true (entering the app
--       with a NULL DOB + full post/book/message rights) or clear a set DOB.
--   (2) a caught minor could self-unblock with PATCH profiles {date_of_birth:null}.
--   (3) guard_min_age only blocks a KNOWN <18 (DOB present) — NULL passes — so an
--       API-direct open-beta signup skipping the onboarding DOB funnel keeps NULL and
--       is never gated.
--
-- Fixes here:
--   (a) guard_profiles_write: date_of_birth is write-once for owners (NULL→value ok;
--       value→NULL/change reverted) and onboarding_done cannot be flipped back to false.
--       Faithful copy of the 20260705030000 owner branch + these two pins.
--   (b) guard_min_age: also block NULL DOB for profiles CREATED ON/AFTER the open-beta
--       cutoff, so new signups must carry a self-attested 18+ DOB to act; pre-cutoff
--       testers (backfill pending) are still allowed, so nobody is bricked.
-- (A Settings DOB backfill field on both client platforms is the remaining piece and
--  is owned by the mobile/web agents — see crossGroupNeeds.)
-- ─────────────────────────────────────────────────────────────────────────────

-- (a) Pin date_of_birth (write-once) and onboarding_done in the profiles guard.
create or replace function public.guard_profiles_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('app.recompute', true) = 'on' then
    return new;
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() = old.id then
    -- owner may edit their own row, but cannot forge trust badges, self-rate,
    -- fabricate earnings, or touch moderation state.
    new.verified               := old.verified;
    new.id_verification_status := old.id_verification_status;
    new.rating                 := old.rating;
    new.review_count           := old.review_count;
    new.poster_rating          := old.poster_rating;
    new.poster_review_count    := old.poster_review_count;
    new.earnings_today         := old.earnings_today;
    new.earnings_week          := old.earnings_week;
    new.earnings_total         := old.earnings_total;
    new.suspended_at           := old.suspended_at;        -- admin-only (console)
    new.suspension_reason      := old.suspension_reason;   -- admin-only (console)
    -- date_of_birth is write-once (self-attested age floor): once set it cannot be
    -- changed or cleared by the owner, so a caught minor cannot self-unblock by
    -- nulling it. NULL→value (first-time backfill at onboarding/Settings) stays allowed.
    if old.date_of_birth is not null then
      new.date_of_birth := old.date_of_birth;
    end if;
    -- onboarding_done cannot be flipped back to false by the owner (prevents dodging
    -- gates by re-entering onboarding); completing onboarding (false→true) stays allowed.
    if old.onboarding_done then
      new.onboarding_done := true;
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- (b) Tighten guard_min_age: block NULL DOB for profiles created on/after open beta.
create or replace function public.guard_min_age()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dob     date;
  created timestamptz;
  -- Open-beta cutoff: signups from this date must carry a self-attested 18+ DOB.
  -- Pre-cutoff testers (backfill pending) keep the NULL-allowed grace so they aren't
  -- bricked; see 20260710070000_open_beta_signups.
  cutoff  constant date := date '2026-07-10';
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  select date_of_birth, created_at into dob, created
    from public.profiles where id = auth.uid();
  -- Known minor (dob present and < 18) → always blocked.
  if dob is not null and dob > (current_date - interval '18 years') then
    raise exception 'You must be 18 or older to do this on GoHustlr.'
      using errcode = 'check_violation';
  end if;
  -- Open-beta signup with no DOB on file → blocked (must complete the age attestation).
  if dob is null and created is not null and created::date >= cutoff then
    raise exception 'Please add your date of birth (18+) to continue on GoHustlr.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Trigger functions must not be directly callable by clients (grants unchanged; the
-- existing trg_min_age_* / trg_guard_profiles_write bindings call these by name).
revoke execute on function public.guard_min_age() from public, anon, authenticated;
