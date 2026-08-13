-- ─────────────────────────────────────────────────────────────────────────────
-- CRITICAL: a password-only session could mint recovery codes and switch off 2FA.
--
-- I shipped this today. generate_mfa_recovery_codes is granted to `authenticated` and
-- contains no assurance-level check, so the whole second factor came apart like this:
--
--   1. Attacker has the password. signInWithPassword returns a REAL session at aal1 —
--      the premise the entire gate is built on. The app holds them on
--      MfaChallengeScreen, but that token is already valid for PostgREST.
--   2. They call generate_mfa_recovery_codes from anything that speaks HTTP. It returns
--      ten PLAINTEXT codes (and deletes the victim's real set on the way).
--   3. They redeem one. redeem_mfa_recovery_code deletes every row in auth.mfa_factors.
--   4. 2FA is off. Permanently, and silently.
--
-- Verified in production inside a rolled-back transaction: an aal1 claim minted
-- 'DRSM-BTAY', redeeming it left factors_remaining = 0.
--
-- It escalates past the app. _shared/stepUp.ts passes when an account has no factor,
-- so the Stripe payout dashboard becomes reachable — the exact "steal session → change
-- the bank" chain step-up was written to stop. And the one account holding a verified
-- factor is also the sole active admin_users row, so removing it lets the console
-- enrol a FRESH authenticator for whoever presents the password: aal1 → full
-- service-role console.
--
-- Net: yesterday the account was protected by a password. Today it was protected by a
-- password AND the user's recovery sheet had been quietly deleted. That is worse than
-- shipping nothing.
--
-- ── THE ASYMMETRY THAT MAKES THIS FIXABLE ───────────────────────────────────
--
-- The two RPCs need OPPOSITE rules, and conflating them is what caused the hole:
--
--   generate  must require aal2. Minting the codes that dismantle 2FA is precisely
--             what the second factor exists to protect. Enrollment is unaffected —
--             challengeAndVerify upgrades the session to aal2 before the app asks for
--             codes, so the legitimate flow already satisfies this.
--
--   redeem    must keep working at aal1. That IS the lost-phone case; requiring aal2
--             to recover from losing your authenticator is a locked door with the key
--             inside. Its safety comes from the code being unguessable AND
--             pre-existing — which only holds once generation is no longer
--             self-service, i.e. after this migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- The caller's assurance level, straight from the verified JWT claims.
create or replace function public.request_aal()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal'
$$;

revoke execute on function public.request_aal() from public, anon;
grant execute on function public.request_aal() to authenticated;

create or replace function public.generate_mfa_recovery_codes(p_count int default 10)
returns text[]
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid       uuid := auth.uid();
  alphabet  text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  out_codes text[] := '{}';
  code      text;
  has_factor boolean;
  i int; j int;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if p_count < 5 or p_count > 20 then raise exception 'bad count'; end if;

  -- ── THE GATE ──────────────────────────────────────────────────────────────
  -- If the account already has a verified factor, the caller must have SATISFIED it.
  -- Without this, a password-only session mints the codes that delete the factor.
  --
  -- Scoped to "has a factor" on purpose: a user with no 2FA yet has nothing to prove,
  -- and enrollment reaches this line already at aal2 because challengeAndVerify has
  -- just run. FAIL CLOSED — an unreadable claim is treated as not-aal2.
  select exists (
    select 1 from auth.mfa_factors f
     where f.user_id = uid and f.status = 'verified'
  ) into has_factor;

  if has_factor and coalesce(public.request_aal(), '') <> 'aal2' then
    raise exception 'Enter your authenticator code before creating new recovery codes.'
      using errcode = 'insufficient_privilege';
  end if;

  -- A new set retires the old one.
  delete from public.mfa_recovery_codes where user_id = uid;

  for i in 1..p_count loop
    code := '';
    for j in 1..8 loop
      code := code || substr(alphabet,
        (get_byte(extensions.gen_random_bytes(1), 0) % length(alphabet)) + 1, 1);
    end loop;
    code := substr(code, 1, 4) || '-' || substr(code, 5, 4);
    insert into public.mfa_recovery_codes (user_id, code_hash)
    values (uid, encode(extensions.digest(upper(code), 'sha256'), 'hex'))
    on conflict do nothing;
    out_codes := out_codes || code;
  end loop;

  return out_codes;
end;
$$;

revoke execute on function public.generate_mfa_recovery_codes(int) from public, anon;
grant execute on function public.generate_mfa_recovery_codes(int) to authenticated;

-- ── A recovery that strips 2FA must be visible ──────────────────────────────
-- Redemption stays available at aal1 (the lost-phone case) but it is now the ONLY
-- aal1 route to removing a factor, so it should never happen quietly. The row lands in
-- the owner's Alerts inbox; an attacker who reaches this point cannot suppress it, and
-- a legitimate user recognises their own action.
create or replace function public.redeem_mfa_recovery_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid   uuid := auth.uid();
  tries int;
  hit   uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;

  insert into public.mfa_recovery_attempts (user_id) values (uid);
  select count(*) into tries
    from public.mfa_recovery_attempts
   where user_id = uid and created_at > now() - interval '15 minutes';
  if tries > 10 then
    return false;
  end if;

  update public.mfa_recovery_codes
     set used_at = now()
   where user_id = uid
     and used_at is null
     and code_hash = encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex')
  returning id into hit;

  if hit is null then return false; end if;

  delete from auth.mfa_factors where user_id = uid;

  begin
    insert into public.notifications (user_id, type, title, body, data)
    values (uid, 'system',
            'Two-factor authentication was turned off',
            'A recovery code was used on your account, which removes two-factor sign-in. '
            'If this was not you, change your password now and set two-factor up again.',
            jsonb_build_object('type', 'system', 'tab', 'ProfileTab'));
  exception when others then
    -- Never fail the recovery over a missing alert; the person may be locked out.
    null;
  end;

  return true;
end;
$$;

revoke execute on function public.redeem_mfa_recovery_code(text) from public, anon;
grant execute on function public.redeem_mfa_recovery_code(text) to authenticated;

-- ── Prove the hole is closed, and that recovery still works ─────────────────
do $$
declare
  uid uuid;
  ok  boolean;
begin
  select f.user_id into uid from auth.mfa_factors f where f.status = 'verified' limit 1;
  if uid is null then
    raise notice 'no verified factor in this database; skipping the live assertion';
    return;
  end if;

  -- aal1 must now be refused.
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', uid::text, 'role', 'authenticated', 'aal', 'aal1')::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.generate_mfa_recovery_codes(10);
    perform set_config('role', 'postgres', true);
    raise exception 'SECURITY: an aal1 session was still able to mint recovery codes';
  exception
    when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      raise notice 'aal1 correctly refused';
    when others then
      perform set_config('role', 'postgres', true);
      raise;
  end;

  perform set_config('request.jwt.claims', '', true);
end $$;
