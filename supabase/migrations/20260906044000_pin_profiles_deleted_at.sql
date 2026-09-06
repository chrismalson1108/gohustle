-- ─────────────────────────────────────────────────────────────────────────────
-- Anyone can mark their own account "erased", page the on-call with it, and undo it.
--
-- guard_profiles_write() is a DENYLIST, and its last definition
-- (20260722020000_pin_created_at_agefloor) predates the column it now has to cover.
-- `profiles.deleted_at` — the erasure tombstone — was added a month later by
-- 20260813150000_profile_tombstone and was never added to the pin list. UPDATE on
-- public.profiles is granted table-wide to `authenticated` (asserted, deliberately, by
-- 20260812040000_grant_rls_parity:131) and profiles_update_own is USING-only, so the
-- guard is the ONLY thing standing between an owner and that column. It waves it through.
--
--     PATCH /rest/v1/profiles?id=eq.<self> {"deleted_at":"2026-09-05T00:00:00Z"}  → 200
--
-- ── WHY IT MATTERS, GIVEN NOTHING READS THE COLUMN ──────────────────────────
--
-- Nothing in src/, web/, shared/ or supabase/functions/ reads deleted_at, so the account
-- keeps working normally — which is the point. The damage is on the operations side:
--
--   1. ctl_tombstone_leaks_pii (20260813150000:81, severity HIGH) returns every row with
--      deleted_at set that still carries a real name/bio/avatar/city/referral_code — i.e.
--      exactly the shape a self-set timestamp produces, since nothing scrubbed anything.
--      controls-alert/index.ts:116 pages on every NEW critical/high finding, so the next
--      :05 sweep wakes a human for "An erased account still has personal data on its
--      profile row" about an account that never asked to be erased and is still posting
--      and booking. PATCH it back to null an hour later and the finding auto-resolves,
--      leaving the operator with a page and nothing to look at. Repeatable at will.
--      That is the pager-credibility failure, self-served.
--
--   2. tombstone_profile() writes `deleted_at = coalesce(deleted_at, now())` (:70) — it
--      deliberately does not overwrite an existing stamp. So a value the user chose
--      SURVIVES a genuine later erasure and becomes the official audit timestamp of when
--      that erasure happened. A retention clock read off a number the erased party wrote
--      themselves is not an audit trail.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- Pin it in the owner branch, the same way every other server-owned column on this table
-- is pinned. NOT a column-level revoke: table-wide UPDATE on profiles is a privilege
-- 20260812040000 asserts the product still has, and narrowing it there would break the
-- profile editor wholesale. The service_role branch and the `app.recompute` branch return
-- early and are untouched, so tombstone_profile() (called by delete-account with the
-- service-role client, index.ts:252) and the console still write the column exactly as
-- before. Erasure stays a server action, which is what it always was meant to be.
--
-- Note the pin is symmetric — an owner can no longer CLEAR the column either. That is
-- correct: un-erasing yourself is no more an owner's call than erasing yourself, and a
-- row already carrying a self-set stamp now stays visible on the control board until an
-- operator with the service role clears it, instead of being toggled away before anyone
-- can look.
--
-- Faithful copy of the latest definition (20260722020000_pin_created_at_agefloor) with
-- one additional pin; every other pin, comment and branch is preserved verbatim.
-- Idempotent.
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
    -- deleted_at is the ERASURE TOMBSTONE, written only by tombstone_profile() under the
    -- service role. Owner-writable, it lets anyone open a HIGH ctl_tombstone_leaks_pii
    -- finding on themselves — which pages the on-call — and lets them pre-stamp the
    -- timestamp a real later erasure keeps (`coalesce(deleted_at, now())`).
    new.deleted_at             := old.deleted_at;
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

revoke execute on function public.guard_profiles_write() from public, anon, authenticated;


-- ── Prove the defect existed and that this pin is what removes it ───────────
--
-- The probe swaps in the PRE-FIX body, reproduces the write and the HIGH finding on a
-- real row, then swaps the fixed body back and repeats the identical write. Two rollback
-- mechanisms, as in 20260813150000: the original column values are restored explicitly,
-- and the whole thing runs inside a block WITH an exception handler — a PL/pgSQL
-- subtransaction — so the staged writes AND the temporary function body are rolled back
-- regardless of how it exits.
do $$
declare
  uid uuid; orig_role text := current_user;
  o_deleted timestamptz; o_name text; o_user text; o_bio text;
  o_avatar text; o_city text; o_ref text; o_skills text[];
  after_old timestamptz; after_new timestamptz;
  after_tomb timestamptz; after_unerase timestamptz;
  leaks_old int; probe_ts constant timestamptz := timestamptz '2026-01-01 00:00:00+00';
begin
  select id, deleted_at, name, username, bio, avatar_url, city, referral_code, skills
    into uid, o_deleted, o_name, o_user, o_bio, o_avatar, o_city, o_ref, o_skills
    from public.profiles
   where deleted_at is null
   order by id limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- ── 1. The defect, on the body that is live today ─────────────────────────
  create or replace function public.guard_profiles_write()
  returns trigger language plpgsql security definer set search_path = public as $g$
  begin
    if current_setting('app.recompute', true) = 'on' then return new; end if;
    if coalesce(auth.role(), '') = 'service_role' then return new; end if;
    if auth.uid() = old.id then
      new.verified               := old.verified;
      new.id_verification_status := old.id_verification_status;
      new.rating                 := old.rating;
      new.review_count           := old.review_count;
      new.poster_rating          := old.poster_rating;
      new.poster_review_count    := old.poster_review_count;
      new.earnings_today         := old.earnings_today;
      new.earnings_week          := old.earnings_week;
      new.earnings_total         := old.earnings_total;
      new.earnings_period_date   := old.earnings_period_date;
      new.suspended_at           := old.suspended_at;
      new.suspension_reason      := old.suspension_reason;
      new.created_at             := old.created_at;
      new.member_since           := old.member_since;
      -- (no deleted_at pin — this is the gap)
      if old.date_of_birth is not null then new.date_of_birth := old.date_of_birth; end if;
      if old.onboarding_done then new.onboarding_done := true; end if;
      return new;
    end if;
    return old;
  end;
  $g$;

  -- Present as the row's owner over PostgREST — table grant, USING-only policy, guard.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  perform set_config('role', 'authenticated', true);
  update public.profiles set deleted_at = probe_ts where id = uid;
  perform set_config('role', orig_role, true);

  select deleted_at into after_old from public.profiles where id = uid;
  select count(*) into leaks_old
    from public.ctl_tombstone_leaks_pii() where entity_id = uid::text;

  if after_old is distinct from probe_ts then
    raise exception 'could not reproduce: the pre-fix guard already refused the write (deleted_at=%)', after_old;
  end if;
  raise notice 'reproduced: an owner PATCHed their own erasure tombstone to %', after_old;
  if leaks_old <> 1 then
    raise exception 'expected ctl_tombstone_leaks_pii (severity high) to open on the self-tombstone, got % rows', leaks_old;
  end if;
  raise notice 'and the HIGH control fires on it — controls-alert pages a human for an account nobody erased';

  update public.profiles set deleted_at = null where id = uid;

  -- ── 2. The fix, same row, same write ──────────────────────────────────────
  create or replace function public.guard_profiles_write()
  returns trigger language plpgsql security definer set search_path = public as $g$
  begin
    if current_setting('app.recompute', true) = 'on' then return new; end if;
    if coalesce(auth.role(), '') = 'service_role' then return new; end if;
    if auth.uid() = old.id then
      new.verified               := old.verified;
      new.id_verification_status := old.id_verification_status;
      new.rating                 := old.rating;
      new.review_count           := old.review_count;
      new.poster_rating          := old.poster_rating;
      new.poster_review_count    := old.poster_review_count;
      new.earnings_today         := old.earnings_today;
      new.earnings_week          := old.earnings_week;
      new.earnings_total         := old.earnings_total;
      new.earnings_period_date   := old.earnings_period_date;
      new.suspended_at           := old.suspended_at;
      new.suspension_reason      := old.suspension_reason;
      new.created_at             := old.created_at;
      new.member_since           := old.member_since;
      new.deleted_at             := old.deleted_at;
      if old.date_of_birth is not null then new.date_of_birth := old.date_of_birth; end if;
      if old.onboarding_done then new.onboarding_done := true; end if;
      return new;
    end if;
    return old;
  end;
  $g$;

  perform set_config('role', 'authenticated', true);
  update public.profiles set deleted_at = probe_ts where id = uid;
  perform set_config('role', orig_role, true);

  select deleted_at into after_new from public.profiles where id = uid;
  if after_new is not null then
    raise exception 'FIX FAILED: the owner still set deleted_at to %', after_new;
  end if;
  raise notice 'discriminates: identical write, identical row — pinned guard leaves deleted_at null';

  -- ── 3. The legitimate path is untouched ───────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.tombstone_profile(uid);
  select deleted_at into after_tomb from public.profiles where id = uid;

  -- ── 4. …and cannot be undone by the person it was applied to ──────────────
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  perform set_config('role', 'authenticated', true);
  update public.profiles set deleted_at = null where id = uid;
  perform set_config('role', orig_role, true);
  select deleted_at into after_unerase from public.profiles where id = uid;

  -- Restore FIRST, so an assertion failure below still leaves the account intact even
  -- if something one day defeats the subtransaction rollback.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.profiles
     set name = o_name, username = o_user, bio = o_bio, avatar_url = o_avatar,
         city = o_city, referral_code = o_ref, skills = o_skills, deleted_at = o_deleted
   where id = uid;
  perform set_config('request.jwt.claims', '', true);

  if after_tomb is null then
    raise exception 'REGRESSION: tombstone_profile() can no longer stamp deleted_at — delete-account would fail closed';
  end if;
  raise notice 'service_role erasure still stamps deleted_at (%), so delete-account is unaffected', after_tomb;
  if after_unerase is null then
    raise exception 'REGRESSION: the erased owner cleared their own tombstone';
  end if;
  raise notice 'and the erased owner cannot clear it back to null';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'deleted_at pin probe passed; staged writes and the temporary body rolled back';
  else
    raise;
  end if;
end $$;
