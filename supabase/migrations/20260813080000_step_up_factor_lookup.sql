-- ─────────────────────────────────────────────────────────────────────────────
-- LIVE OUTAGE: payout setup has been failing for every user since this morning.
--
-- _shared/stepUp.ts asks whether the account has a verified factor with
--
--     service.schema('auth').from('mfa_factors').select('id')…
--
-- PostgREST cannot reach it. The `auth` schema is not in db_schemas, and service_role
-- holds NO grants on auth.mfa_factors — verified: both come back empty. So the lookup
-- ALWAYS errors, and requireStepUp fails closed by design, returning 503 to every
-- caller of stripe-connect-onboard and stripe-payout-login-link.
--
-- Failing closed was the right instinct and it is why this is an outage rather than a
-- breach: nobody's bank details were exposed, everybody was simply locked out of
-- their own payout settings. But a check that can never succeed is not a check, and I
-- shipped it without exercising the path — the same mistake as the Modal import,
-- caught this time by an audit rather than by Chris.
--
-- The fix is a SECURITY DEFINER function in `public`, which is what every other
-- cross-schema read in this codebase already does.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.user_has_verified_mfa(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.mfa_factors f
     where f.user_id = p_user and f.status = 'verified'
  )
$$;

-- Edge functions call this with the service role. No client ever needs it: a user's
-- own 2FA state is already on their session, and exposing "does this account have
-- 2FA" to anyone else is a small enumeration gift.
revoke execute on function public.user_has_verified_mfa(uuid) from public, anon, authenticated;
grant execute on function public.user_has_verified_mfa(uuid) to service_role;

do $$
declare uid uuid; with_mfa boolean; without_mfa boolean;
begin
  select f.user_id into uid from auth.mfa_factors f where f.status = 'verified' limit 1;
  if uid is null then raise notice 'no verified factor here; skipping'; return; end if;

  with_mfa := public.user_has_verified_mfa(uid);
  select public.user_has_verified_mfa(u.id) into without_mfa
    from auth.users u where u.id <> uid
      and not exists (select 1 from auth.mfa_factors f where f.user_id = u.id)
    limit 1;

  if not with_mfa then
    raise exception 'user_has_verified_mfa returned false for an account WITH a factor';
  end if;
  if without_mfa then
    raise exception 'user_has_verified_mfa returned true for an account with no factor';
  end if;
  raise notice 'step-up factor lookup works: with=%, without=%', with_mfa, without_mfa;
end $$;
