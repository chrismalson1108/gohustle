-- ─────────────────────────────────────────────────────────────────────────────
-- Erasing an account left its Google/Apple identity attached to the banned auth row —
-- so "Continue with Google" never works again, and the provider's copy of the person's
-- name, email and avatar survives the erasure.
--
-- delete-account's step 5 rewrites auth.users.email, clears user_metadata and bans the
-- row for a century, and its comment claims "what remains is an opaque uuid with no
-- personal data attached". That is true for a password account and false for a social
-- one. The app signs users in with supabase.auth.signInWithIdToken for both google
-- (src/context/AuthContext.js:279) and apple (:372); GoTrue resolves an ID token by
-- (provider, provider_id) in auth.identities, and updateUserById neither deletes nor
-- rewrites identity rows. They keep the provider's `sub` and their identity_data —
-- email, full name, avatar URL.
--
-- Two consequences:
--
--   · The identity still points at the banned user, so every future "Continue with
--     Google/Apple" by that person resolves to a banned account and is refused. No path
--     mints a NEW user for a `sub` that already has an identity, so the button is dead
--     for good — on a platform whose audience largely signs in that way. The real email
--     address IS freed by step 5, so they can still register with a password; the
--     button they actually use is what stops working, with no message that explains it.
--   · identity_data is retained personal data on an account that asked to be erased,
--     and nothing in the repo has ever touched auth.identities.
--
-- ── WHY THIS SITS IN tombstone_profile ──────────────────────────────────────
-- delete-account already treats the scrub as FAIL CLOSED: if tombstone_profile returns
-- an error it refuses to go further and tells the person to retry, because a
-- half-completed erasure is worse than none. Identity removal belongs on the same side
-- of that line. Done as a best-effort call in the edge function it would be exactly the
-- kind of step that fails quietly and locks somebody out; done here, either the account
-- is fully erased or nothing happened. Any future caller of the scrub inherits it too.
--
-- ── WHY THE EMAIL IDENTITY IS SCRUBBED RATHER THAN DELETED ──────────────────
-- Step 5 runs GoTrue's admin email update immediately after this, and that path reads
-- and rewrites the `email` provider's identity. Removing that row would have this
-- migration betting on a GoTrue internal that cannot be exercised from here, and losing
-- the bet means every deletion reports failure after having already scrubbed the
-- profile. The social identities are the lockout and the retained provider PII; the
-- email identity's only personal field is the address, which is overwritten with the
-- same neutral value step 5 writes to auth.users. auth.identities.email is a generated
-- column over identity_data in current Supabase, so it follows on its own.
--
-- Found by the 2026-09 platform audit (edge-support-safety-ai#5, also reported by
-- notifications-realtime-privacy#6).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.tombstone_profile(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if p_user is null then return false; end if;

  -- The .edu address of an account that asked to be erased. The FK's `on delete
  -- cascade` cannot reach it, because the profile row is kept on purpose — and while
  -- it survives, `uniq_consumed_student_email` stops the person (or anyone) from ever
  -- verifying that inbox again.
  delete from public.student_email_verifications where user_id = p_user;

  -- The Google/Apple identity. Left in place it holds the provider's `sub`, so every
  -- future social sign-in resolves to this banned row and is refused — permanently, and
  -- with no message that explains it — while identity_data keeps the provider's copy of
  -- the person's name, email and avatar.
  delete from auth.identities
   where user_id = p_user
     and provider not in ('email', 'phone');

  -- The password identity is kept (step 5 of delete-account rewrites it) but its only
  -- personal field is neutralised, to the same value the auth row itself gets.
  update auth.identities
     set identity_data = identity_data
                         || jsonb_build_object('email', 'deleted-' || p_user::text || '@removed.invalid'),
         updated_at = now()
   where user_id = p_user
     and identity_data ? 'email';

  update public.profiles
     set name            = 'Deleted user',
         -- `username_format` is ^[a-z0-9_]{3,30}$, and 'deleted_' + a bare uuid is 40
         -- chars. Take the first 22 hex digits: still unique in practice, still frees
         -- the person's real handle, and it fits the constraint the app relies on.
         username        = 'deleted_' || substr(replace(p_user::text, '-', ''), 1, 22),
         bio             = null,
         avatar_url      = null,
         city            = null,
         skills          = '{}',
         -- A referral code is a public handle someone may have shared; freeing it also
         -- stops a deleted account continuing to attribute new signups.
         referral_code   = null,
         deleted_at      = coalesce(deleted_at, now())
   where id = p_user;

  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke execute on function public.tombstone_profile(uuid) from public, anon, authenticated;
grant execute on function public.tombstone_profile(uuid) to service_role;

-- ── The accounts already erased ─────────────────────────────────────────────
-- Everyone who has deleted an account so far is still holding a live identity pointed
-- at a banned user, which is the lockout. Clear them the same way.
delete from auth.identities i
 using public.profiles p
 where p.id = i.user_id
   and p.deleted_at is not null
   and i.provider not in ('email', 'phone');

update auth.identities i
   set identity_data = i.identity_data
                       || jsonb_build_object('email', 'deleted-' || i.user_id::text || '@removed.invalid'),
       updated_at = now()
  from public.profiles p
 where p.id = i.user_id
   and p.deleted_at is not null
   and i.identity_data ? 'email'
   and i.identity_data->>'email' not like 'deleted-%@removed.invalid';

-- ── The control ─────────────────────────────────────────────────────────────
-- Same subject as the rest of ctl_tombstone_leaks_pii: erased, but personal data
-- remains. A social identity is that AND a locked-out person, so it is worth the row.
create or replace function public.ctl_tombstone_leaks_pii()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'deleted_at', p.deleted_at,
           'has_name', p.name is distinct from 'Deleted user',
           'has_bio', p.bio is not null,
           'has_avatar', p.avatar_url is not null,
           'has_city', p.city is not null,
           'has_referral_code', p.referral_code is not null,
           -- The FK on this table is `on delete cascade`, and the cascade can never
           -- fire on a tombstone. A row here is the person's plain-text school email
           -- AND a permanent block on re-verifying that inbox.
           'has_school_email', exists (
             select 1 from public.student_email_verifications s where s.user_id = p.id),
           -- A live Google/Apple identity on a banned user: their provider profile is
           -- still stored, and "Continue with Google" is dead for them.
           'has_social_identity', exists (
             select 1 from auth.identities i
              where i.user_id = p.id and i.provider not in ('email', 'phone')),
           'note', 'this account was erased but personal data remains on the profile row')
    from public.profiles p
   where p.deleted_at is not null
     and (p.name is distinct from 'Deleted user'
       or p.bio is not null
       or p.avatar_url is not null
       or p.city is not null
       or p.referral_code is not null
       or exists (select 1 from public.student_email_verifications s where s.user_id = p.id)
       or exists (select 1 from auth.identities i
                   where i.user_id = p.id and i.provider not in ('email', 'phone')))
$$;

revoke execute on function public.ctl_tombstone_leaks_pii() from public, anon, authenticated;


-- ── Prove it, on a staged identity, rolled back ─────────────────────────────
--
-- This probe also serves as the PRIVILEGE check: the delete above runs as this
-- function's owner, so if that role cannot write auth.identities the failure belongs
-- here, at push time, rather than at the moment somebody tries to delete their account.
do $$
declare
  uid uuid; sub text; n_social int; n_email int; email_after text; leaks int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;
  sub := 'probe-sub-' || replace(uid::text, '-', '');

  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (sub, uid,
          jsonb_build_object('sub', sub, 'email', 'probe@example.com', 'full_name', 'Probe Person'),
          'probe_oauth', now(), now());
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (uid::text, uid,
          jsonb_build_object('sub', uid::text, 'email', 'probe@example.com'),
          'email', now(), now())
  on conflict do nothing;

  -- Before: this is the state every erased social user is in right now — a live
  -- identity carrying the provider's `sub` and their name.
  select count(*) into n_social from auth.identities
   where user_id = uid and provider = 'probe_oauth';
  if n_social <> 1 then raise exception 'could not stage the social identity (%)', n_social; end if;

  perform public.tombstone_profile(uid);

  if not exists (select 1 from public.profiles where id = uid and deleted_at is not null) then
    raise exception 'tombstone_profile did not tombstone; the rest of this probe means nothing';
  end if;

  select count(*) into n_social from auth.identities
   where user_id = uid and provider not in ('email', 'phone');
  if n_social <> 0 then
    raise exception 'FIX FAILED: % social identit(ies) survived the erasure — the person is still locked out', n_social;
  end if;
  raise notice 'the social identity is gone, so the provider sub is free and the sign-in button works again';

  -- The email identity is deliberately KEPT — step 5 of delete-account rewrites it —
  -- but no identity may still carry a real address.
  select count(*) into n_email
    from auth.identities where user_id = uid and provider = 'email';
  if n_email < 1 then
    raise exception 'the email identity was removed; step 5 of delete-account depends on it';
  end if;
  select max(i.identity_data->>'email') into email_after
    from auth.identities i
   where i.user_id = uid
     and i.identity_data->>'email' is distinct from 'deleted-' || uid::text || '@removed.invalid';
  if email_after is not null then
    raise exception 'an identity still carries %, which is the address the erasure was about', email_after;
  end if;
  raise notice 'the password identity survives for GoTrue, with the address neutralised';

  -- The control is silent on that clean tombstone, and fires on a dirty one.
  select count(*) into leaks from public.ctl_tombstone_leaks_pii() where entity_id = uid::text;
  if leaks <> 0 then
    raise exception 'the control fires on a fully erased account — permanent noise';
  end if;
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (sub || '-2', uid, jsonb_build_object('sub', sub || '-2'), 'probe_oauth', now(), now());
  select count(*) into leaks from public.ctl_tombstone_leaks_pii() where entity_id = uid::text;
  if leaks <> 1 then
    raise exception 'ctl_tombstone_leaks_pii reported % rows for a tombstone that still has a social identity', leaks;
  end if;
  raise notice 'a regression here is reported rather than discovered by a locked-out user';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'auth-identity erasure probe passed; every staged row rolled back';
  else
    raise;
  end if;
end $$;
