-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM, trust/impersonation): the "Verified Student" badge was rendered
-- against a free-text, user-editable school (2026-07-26).
--
-- guard_student_verified (migration_student_verification.sql) correctly pins the
-- trust fields — student_verified, student_verified_at, student_verify_method — so a
-- user cannot grant themselves the badge. Its own comment states the intent: "Users
-- may freely edit school/major/etc., but NOT the verified flag/method."
--
-- But `school` (and `school_domain`) are exactly what the badge is rendered NEXT TO.
-- Verification proves control of an address at one institution's domain; the label
-- shown to other users is a separate free-text column the owner can rewrite at any
-- time. So:
--
--   1. verify with a real address at the community college you attend  -> badge granted
--   2. PATCH /rest/v1/profiles {"school":"Stanford University"}         -> allowed
--   3. your profile now reads "Stanford University" with a platform-issued
--      "Verified Student" badge beside it
--
-- The badge is a trust signal posters use when deciding who to let into their home,
-- so a verified-looking mislabel is worth more than an unverified one. The guard
-- protected the flag and left the claim it vouches for wide open.
--
-- Fix: once student_verified is true, pin `school` and `school_domain` for
-- non-service-role writers, exactly as the trust fields are pinned. Unverified users
-- keep editing school freely (it is just a self-reported field then, and no badge is
-- shown). Support/admin can still correct a genuine mistake through the service role,
-- and student-verify-confirm sets both columns as service_role when the badge is
-- granted.
--
-- Function generated from the original so the existing pins are byte-identical; only
-- the two new pins are added. Trigger definition unchanged. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_student_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.student_verified      := old.student_verified;
    new.student_verified_at   := old.student_verified_at;
    new.student_verify_method := old.student_verify_method;
    -- Once the badge is granted, the institution it vouches for is part of the claim
    -- and can no longer be self-edited. Unverified users are unaffected.
    if coalesce(old.student_verified, false) then
      new.school        := old.school;
      new.school_domain := old.school_domain;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_student_verified() from public, anon, authenticated;

drop trigger if exists trg_guard_student_verified on public.profiles;
create trigger trg_guard_student_verified
  before update on public.profiles
  for each row execute function public.guard_student_verified();

-- Verify post-deploy:
--   * unverified user: PATCH profiles {"school":"Anywhere"}  -> stored
--   * verified user:   PATCH profiles {"school":"Stanford"}  -> silently reverted
--   * service_role (student-verify-confirm / admin)          -> still able to set it
