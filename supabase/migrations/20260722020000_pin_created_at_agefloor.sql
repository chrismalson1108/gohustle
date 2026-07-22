-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY: pin profiles.created_at (and member_since) in guard_profiles_write
-- (2026-07-22).
--
-- guard_min_age() (20260715040000_age_floor_hardening) enforces the open-beta age
-- floor by reading BOTH date_of_birth AND created_at from the caller's own profiles
-- row: a signup on/after the 2026-07-10 cutoff with a NULL date_of_birth is blocked
-- from posting/booking/messaging. But guard_profiles_write() is a DENYLIST that pins
-- verified/ratings/earnings/earnings_period_date/suspension/date_of_birth/
-- onboarding_done and NEVER pinned created_at. UPDATE on public.profiles is granted
-- table-wide to `authenticated` (only additive column grants were ever layered on),
-- and profiles_update_own is USING-only, so an owner could:
--     PATCH /rest/v1/profiles?id=eq.<self> {"created_at":"2026-07-01T00:00:00Z"}
-- to backdate their signup before the cutoff. guard_min_age's NULL-DOB branch then
-- no longer fires, and a NULL-DOB open-beta account transacts with NO age attestation
-- at all — defeating fix (b) of 20260715040000.
--
-- Fix: pin created_at and member_since in the owner branch so neither can be forged
-- (member_since is the displayed "joined" trust signal — pin it for the same reason).
-- Faithful copy of the latest definition (20260722010000_audit_followups) with only
-- these two additional pins; every other pin is preserved verbatim. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

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
    new.earnings_period_date   := old.earnings_period_date;  -- server bookkeeping only
    new.suspended_at           := old.suspended_at;        -- admin-only (console)
    new.suspension_reason      := old.suspension_reason;   -- admin-only (console)
    -- created_at feeds the guard_min_age open-beta cutoff decision, so it must not be
    -- owner-writable — otherwise a NULL-DOB signup backdates it before the cutoff and
    -- skips the age attestation. member_since is the displayed "joined" trust signal.
    new.created_at             := old.created_at;
    new.member_since           := old.member_since;
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

revoke execute on function public.guard_profiles_write() from public;
