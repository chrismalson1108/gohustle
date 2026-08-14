-- ─────────────────────────────────────────────────────────────────────────────
-- Two ways the recovery-code system could lock a user out of their own account.
--
-- CLAUDE.md states the principle already: "2FA without a way back in turns a lost phone
-- into a lost account." Both of these break that promise from the inside.
--
-- ── 1. GENERATION, not delivery, was the point of no return ─────────────────
--
-- generate_mfa_recovery_codes opened with
--
--     delete from public.mfa_recovery_codes where user_id = uid;
--
-- and only then minted and returned the new set. The transaction commits the moment the
-- function returns, so if the RESPONSE is lost — a dropped connection, a backgrounded
-- app, a killed process on a phone — the user is left with the old codes destroyed and
-- the new codes existing only as hashes they have never seen. Zero usable codes. Add a
-- lost phone and the account is gone, which is precisely the outcome recovery codes are
-- there to prevent.
--
-- The fix is to make DELIVERY the irreversible step. Generation now leaves the previous
-- batch alive; `confirm_mfa_recovery_codes()` retires it, and the client calls that only
-- after it has the plaintext in hand and on screen. If the response is lost, the old
-- codes still work — the user is exactly where they started rather than locked out.
--
-- Bounded on purpose: generation first drops everything OLDER than the most recent
-- batch, so at most two batches (the previous one and the new one) are ever live, even
-- if a client generates repeatedly and never confirms. The window where both work is the
-- round trip, and "briefly, the codes you already had still work" is a far better
-- failure than "silently, nothing works".
--
-- ── 2. The rate limiter extended its own window ─────────────────────────────
--
-- redeem_mfa_recovery_code recorded the attempt and THEN counted:
--
--     insert into public.mfa_recovery_attempts (user_id) values (uid);
--     select count(*) into tries from ... where created_at > now() - interval '15 minutes';
--     if tries > 10 then return false; end if;
--
-- so every attempt made while already over the limit added another row inside the
-- window. A user mistyping a code — which is the expected behaviour of someone reading
-- 8 characters off paper, under stress, having just lost their phone — pushes the
-- 15-minute window forward with each try and can hold themselves out indefinitely. The
-- limiter is meant to slow an attacker; here it was most effective against the account's
-- real owner, who is the one who cannot simply give up.
--
-- Checking BEFORE recording means the window drains on a fixed schedule: over the limit,
-- wait it out, and it clears. An attacker is bounded exactly as before — 10 guesses per
-- 15 minutes against an 8-character code from a 31-character alphabet.
-- ─────────────────────────────────────────────────────────────────────────────

-- Batches are ordered by a SEQUENCE, not by created_at. `now()` is the TRANSACTION
-- timestamp and is constant within one transaction, so two batches minted in the same
-- transaction share a created_at and "older than the newest" matches nothing — which is
-- exactly how the first version of this probe failed. nextval is non-transactional and
-- strictly increasing, so the ordering holds however the calls are grouped.
-- Pre-existing rows carry NULL and are treated as oldest via coalesce(batch, 0).
create sequence if not exists public.mfa_recovery_batch_seq;
alter table public.mfa_recovery_codes add column if not exists batch bigint;

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
  v_batch bigint;
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

  -- Keep the CURRENT batch alive; retire anything older. The previous batch is the
  -- user's only way back in until they have actually seen the new one, so it dies in
  -- confirm_mfa_recovery_codes, not here. Dropping older-than-current bounds this at two
  -- live batches no matter how often generation is retried without confirming.
  delete from public.mfa_recovery_codes
   where user_id = uid
     and coalesce(batch, 0) < (
       select coalesce(max(batch), 0) from public.mfa_recovery_codes where user_id = uid
     );

  v_batch := nextval('public.mfa_recovery_batch_seq');

  for i in 1..p_count loop
    code := '';
    for j in 1..8 loop
      code := code || substr(alphabet,
        (get_byte(extensions.gen_random_bytes(1), 0) % length(alphabet)) + 1, 1);
    end loop;
    code := substr(code, 1, 4) || '-' || substr(code, 5, 4);
    insert into public.mfa_recovery_codes (user_id, code_hash, batch)
    values (uid, encode(extensions.digest(upper(code), 'sha256'), 'hex'), v_batch)
    on conflict do nothing;
    out_codes := out_codes || code;
  end loop;

  return out_codes;
end;
$$;

-- ── Delivery confirmed: NOW the old set can go ──────────────────────────────
-- Retires every batch older than the newest one. Idempotent, and safe to call when
-- there is nothing to retire. Deletes only the caller's own rows and can never grant
-- access, so it needs no aal2 gate of its own.
create or replace function public.confirm_mfa_recovery_codes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n   integer;
begin
  if uid is null then raise exception 'not signed in'; end if;

  with gone as (
    delete from public.mfa_recovery_codes
     where user_id = uid
       and coalesce(batch, 0) < (
         select coalesce(max(batch), 0) from public.mfa_recovery_codes where user_id = uid
       )
    returning 1
  )
  select count(*) into n from gone;

  return coalesce(n, 0);
end;
$$;

revoke execute on function public.confirm_mfa_recovery_codes() from public, anon;
grant execute on function public.confirm_mfa_recovery_codes() to authenticated;

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

  -- COUNT FIRST, THEN RECORD. Recording first made every over-limit attempt extend the
  -- window, so the person locked out could never wait it out — and the person locked out
  -- is overwhelmingly the account's own owner, typing an 8-character code off paper
  -- having just lost their phone. An attacker is bounded identically either way.
  select count(*) into tries
    from public.mfa_recovery_attempts
   where user_id = uid and created_at > now() - interval '15 minutes';
  if tries >= 10 then
    return false;
  end if;

  insert into public.mfa_recovery_attempts (user_id) values (uid);

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

-- ── Prove both, on a staged user, rolled back ───────────────────────────────
do $$
declare
  uid uuid; n_after_first int; n_after_second int; n_after_confirm int;
  tries_before int; tries_after int; ok boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- Clear any real state for this account so the probe measures only itself, and so a
  -- genuine user's codes are never counted (all of it rolls back regardless).
  delete from public.mfa_recovery_codes where user_id = uid;
  delete from public.mfa_recovery_attempts where user_id = uid;

  -- Act as that user. generate's aal2 gate only applies when a verified factor exists;
  -- a staged account has none, which is the enrollment case.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);

  perform public.generate_mfa_recovery_codes(5);
  select count(*) into n_after_first from public.mfa_recovery_codes where user_id = uid;

  -- Second generation must NOT destroy the first set — that is the whole fix.
  perform public.generate_mfa_recovery_codes(5);
  select count(*) into n_after_second from public.mfa_recovery_codes where user_id = uid;

  if n_after_first <> 5 then
    raise exception 'staging wrong: first generation produced % codes', n_after_first;
  end if;
  if n_after_second <> 10 then
    raise exception
      'FIX FAILED: regenerating destroyed the old set before delivery (% codes live, expected 10)',
      n_after_second;
  end if;
  raise notice 'old batch survives generation: % codes live across two batches', n_after_second;

  -- Delivery confirmed → the previous batch retires.
  select public.confirm_mfa_recovery_codes() into n_after_confirm;
  if n_after_confirm <> 5 then
    raise exception 'confirm retired % rows, expected 5', n_after_confirm;
  end if;
  select count(*) into n_after_confirm from public.mfa_recovery_codes where user_id = uid;
  if n_after_confirm <> 5 then
    raise exception 'after confirm % codes remain, expected exactly the newest 5', n_after_confirm;
  end if;
  raise notice 'confirm retired the previous batch; % codes remain', n_after_confirm;

  -- ── The limiter must stop EXTENDING its own window ───────────────────────
  delete from public.mfa_recovery_attempts where user_id = uid;
  insert into public.mfa_recovery_attempts (user_id)
    select uid from generate_series(1, 12);
  select count(*) into tries_before from public.mfa_recovery_attempts
   where user_id = uid and created_at > now() - interval '15 minutes';

  -- Already far over the limit. A refused attempt must not be recorded.
  select public.redeem_mfa_recovery_code('ZZZZ-ZZZZ') into ok;
  select count(*) into tries_after from public.mfa_recovery_attempts
   where user_id = uid and created_at > now() - interval '15 minutes';

  if ok then
    raise exception 'a bogus code was accepted';
  end if;
  if tries_after <> tries_before then
    raise exception
      'FIX FAILED: the limiter still extends its own window (% -> % attempts while over the limit)',
      tries_before, tries_after;
  end if;
  raise notice 'over-limit attempt refused WITHOUT recording: attempts held at %', tries_after;

  -- And it must still admit a legitimate attempt once the window is clear.
  delete from public.mfa_recovery_attempts where user_id = uid;
  select public.redeem_mfa_recovery_code('ZZZZ-ZZZZ') into ok;
  select count(*) into tries_after from public.mfa_recovery_attempts where user_id = uid;
  if tries_after <> 1 then
    raise exception 'OVER-CORRECTED: a legitimate attempt was not recorded (% rows)', tries_after;
  end if;
  raise notice 'a legitimate attempt is still recorded';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'recovery-code probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
