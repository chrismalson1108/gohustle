-- Security Advisor hardening: SECURITY DEFINER functions were EXECUTE-granted to
-- PUBLIC (Postgres default), so anon/authenticated could invoke them via the API.
-- Trigger functions never need caller EXECUTE (they fire in the trigger owner's
-- context), and the money-credit RPCs are service-role-only.
--
-- IMPORTANT: `REVOKE ... FROM PUBLIC` also removes the implicit grant service_role
-- and authenticated hold via PUBLIC membership. So we revoke from PUBLIC and then
-- RE-GRANT the roles that genuinely need each function — never leave an edge-fn or
-- a legitimate client RPC without EXECUTE.
--
-- Client RPC callers (verified by grep, 2026-07-02):
--   my_profile()                 mobile UserContext / web user.tsx / assistant (authenticated JWT)
--   recompute_user_rating(uuid)  mobile JobsContext / web jobs.tsx (authenticated)
--   profile_availability(uuid)   mobile PublicProfileScreen / web u/[id] (authenticated)
--   area_market_stats()          mobile MarketInsightsScreen / web insights (authenticated)
-- Service-role-only RPCs (called from edge fns with the service key):
--   credit_earnings(uuid), claim_and_credit_tip(...)
-- Everything else below is a trigger/event function (no caller EXECUTE needed).

-- Trigger/event functions: revoke caller EXECUTE entirely (triggers still fire).
do $$
declare fn text;
begin
  foreach fn in array array[
    'advance_mutual_completion()',
    'guard_bookings_write()',
    'guard_jobs_delete()',
    'guard_jobs_write()',
    'guard_profiles_write()',
    'guard_started_booking_cancel()',
    'guard_student_verified()',
    'handle_new_user()',
    'notify_saved_searches()',
    'rls_auto_enable()',
    'sync_slot_taken()'
  ] loop
    begin
      execute format('revoke execute on function public.%s from public', fn);
    exception when undefined_function then
      raise notice 'skip revoke (not found): %', fn;
    end;
  end loop;
end $$;

-- Service-role-only money RPCs: strip PUBLIC, keep service_role (edge fns need it).
do $$
declare sig text;
begin
  foreach sig in array array[
    'credit_earnings(uuid)',
    'claim_and_credit_tip(text, uuid, uuid, integer)'
  ] loop
    begin
      execute format('revoke execute on function public.%s from public', sig);
      execute format('grant execute on function public.%s to service_role', sig);
    exception when undefined_function then
      raise notice 'skip money rpc (not found): %', sig;
    end;
  end loop;
end $$;

-- Client-facing RPCs: signed-in users only (+ service_role for backend safety).
do $$
declare sig text;
begin
  foreach sig in array array[
    'my_profile()',
    'recompute_user_rating(uuid)',
    'profile_availability(uuid)',
    'area_market_stats()'
  ] loop
    begin
      execute format('revoke execute on function public.%s from public', sig);
      execute format('grant execute on function public.%s to authenticated, service_role', sig);
    exception when undefined_function then
      raise notice 'skip client rpc (not found): %', sig;
    end;
  end loop;
end $$;
