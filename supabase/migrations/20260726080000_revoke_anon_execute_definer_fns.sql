-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM): `revoke execute ... from public` did NOT remove anon's EXECUTE
-- (2026-07-26).
--
-- 20260702000000_revoke_definer_function_execute.sql locked down the SECURITY DEFINER
-- surface with, for each function:
--     revoke execute on function public.<f> from public;
--     grant  execute on function public.<f> to authenticated, service_role;
--
-- That is the correct instinct but an incomplete revoke on Supabase. A stock Supabase
-- project ships ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions in `public`
-- to the `anon` and `authenticated` roles DIRECTLY. Revoking from PUBLIC removes only
-- the PUBLIC pseudo-role grant; the explicit per-role grant to `anon` survives it.
--
-- Verified against production with the embedded anon key and no account:
--     POST /rest/v1/rpc/profile_availability {"uid":"..."}  -> 200
--     POST /rest/v1/rpc/mask_location {"loc":"123 Main St, Dallas, TX"}
--                                                          -> 200 "Dallas, TX"
-- while the functions that were never granted to anon in the first place correctly
-- return 42501 (my_profile, area_market_stats, admin_dashboard_metrics,
-- credit_earnings, admin_revoke_sessions, contains_prohibited).
--
-- profile_availability is the one that matters: 20260630000000 introduced it precisely
-- so availability could be served through a SECURITY DEFINER RPC that enforces
-- (show_availability OR self) after REVOKING the raw column grant — its stated goal
-- being that anonymous visitors can never read availability. The anon EXECUTE left
-- that guarantee unmet, so an unauthenticated caller could read any opted-in user's
-- availability schedule (when a named person is free, and where they work) — the same
-- class of data the H4/H5 anon revocations closed on profiles and jobs.
--
-- mask_location is a pure text transform with no data access, so exposure is
-- immaterial — but it is an internal helper and there is no reason for it to be an
-- endpoint. It is not SECURITY DEFINER, so the sweep below misses it; revoked
-- explicitly.
--
-- Fix: sweep EVERY SECURITY DEFINER function in `public` and revoke anon's EXECUTE.
-- A blanket sweep rather than a name list, because the failure here was precisely that
-- a hand-maintained list plus an incomplete revoke verb left a gap — and any future
-- definer function will inherit the same default grant. No definer RPC in this app is
-- meant to be callable without a session (the only anon-facing data is the
-- legal_documents table, which is not a function).
--
-- authenticated / service_role grants are untouched, so every signed-in flow is
-- unchanged. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef            -- SECURITY DEFINER only
  loop
    execute format('revoke execute on function %s from anon', r.sig);
  end loop;
end $$;

-- Not SECURITY DEFINER, so not covered above: an internal masking helper that has no
-- business being reachable as /rest/v1/rpc/mask_location.
do $$
begin
  execute 'revoke execute on function public.mask_location(text) from anon, public';
exception when undefined_function then
  raise notice 'mask_location(text) not present; skipping';
end $$;

-- Verify post-deploy — both must now return 42501 for the anon key:
--   curl -X POST "$SUPABASE_URL/rest/v1/rpc/profile_availability" \
--     -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
--     -d '{"uid":"00000000-0000-0000-0000-000000000000"}'
--   curl -X POST "$SUPABASE_URL/rest/v1/rpc/mask_location" \
--     -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
--     -d '{"loc":"123 Main St, Dallas, TX"}'
-- ...and a signed-in caller must still get 200 from profile_availability.
