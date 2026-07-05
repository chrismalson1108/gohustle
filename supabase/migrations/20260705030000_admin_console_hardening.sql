-- ─────────────────────────────────────────────────────────────────────────────
-- Admin console — post-build security hardening (adversarial review, 2026-07-05).
--
--  #1 (MEDIUM, confirmed): profiles.suspended_at / suspension_reason were added by
--     20260705010000 but the profiles write-guard is a DENYLIST that never pinned
--     them, and there is no table-wide UPDATE lockdown on profiles. So any signed-in
--     user could PATCH their OWN suspended_at/suspension_reason (clear a flag, spoof
--     state, inject text into an admin-internal field). Pin both columns in the guard
--     owner-branch — same pattern already used for verified/rating/earnings_*.
--
--  #2 (HIGH, confirmed): the console's "force sign-out" targeted GoTrue endpoint
--     POST /admin/users/{id}/logout, which DOES NOT EXIST on hosted Supabase — so it
--     always fell back to a 24h ban, silently overwriting a permanent suspension.
--     Provide a real primitive: admin_revoke_sessions() deletes the user's refresh
--     sessions (service-role only). The app calls this instead of the ban fallback.
-- ─────────────────────────────────────────────────────────────────────────────

-- #1 — faithful copy of the review3 (20260624203000) guard body, with suspended_at
-- and suspension_reason added to the owner-branch pin list. create-or-replace keeps
-- the existing trg_guard_profiles_write binding and EXECUTE grants intact.
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
    return new;
  end if;
  return old;
end;
$$;

-- #2 — deterministic "force sign-out": drop the user's refresh sessions. Access JWTs
-- already issued remain valid until they expire (~1h TTL, Supabase-inherent), but no
-- new tokens can be minted. SECURITY DEFINER so it runs as the migration owner (which
-- has rights on the auth schema); service_role-only EXECUTE. Returns the count for
-- the audit trail.
create or replace function public.admin_revoke_sessions(target uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  removed integer;
begin
  delete from auth.sessions where user_id = target;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.admin_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.admin_revoke_sessions(uuid) to service_role;
