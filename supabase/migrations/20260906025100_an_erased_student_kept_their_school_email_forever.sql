-- ─────────────────────────────────────────────────────────────────────────────
-- Deleting your account kept your .edu address forever, and locked you out of ever
-- verifying it again.
--
-- student_email_verifications.user_id is `references public.profiles(id) on delete
-- cascade` (supabase/migration_student_verification.sql:38) — the cascade is the ONLY
-- cleanup this table has. Since 20260813150000 the account is TOMBSTONED rather than
-- deleted: tombstone_profile() UPDATEs the profile and delete-account deliberately does
-- not delete the auth row, because profiles_id_fkey cascades to jobs → bookings →
-- payments, i.e. the counterparty's financial records. That decision is right, and its
-- side effect is that this cascade can never fire again. Nothing else deletes from the
-- table: delete-account does not mention it, and the console's only reference to it is
-- the PII export.
--
-- So a consumed row — the person's real school email, in plain text — outlives the
-- erasure indefinitely. That is retained PII on an account that asked to be erased.
--
-- ── AND IT LOCKS THE PERSON OUT ─────────────────────────────────────────────
-- The one-inbox-one-account rule is keyed purely on that row, at two levels:
--
--   · `uniq_consumed_student_email` (20260624210000:32) is unique on (email) where
--     consumed. The surviving row makes a second consumed row for the same inbox
--     impossible AT THE DATABASE, whatever the edge functions decide.
--   · student-verify-start finds a consumed row under a different user_id and returns
--     `{ ok: true }` WITHOUT sending a code — deliberately indistinguishable from
--     success, so the endpoint cannot be used as an oracle. The mobile modal advances
--     to "enter the code" and the code never arrives; the retry hits the same branch.
--     student-verify-confirm then answers `no_pending` ("Request a new code"), because
--     start returned before inserting one.
--
-- That is the ordinary "delete my account and start fresh" flow Apple 5.1.1(v) requires
-- us to offer: jane@stanford.edu verifies, deletes, re-registers next semester, and can
-- never hold the Verified Student badge again. There is no self-service repair and no
-- console repair — support cannot see this table.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- tombstone_profile() deletes the rows, so every caller of the scrub inherits it (there
-- is exactly one today, and this is the reason to put it there rather than in the edge
-- function). Existing rows stranded under already-tombstoned profiles are cleared in the
-- same migration, because the fix above only reaches erasures from here on.
--
-- Deleting rather than scrubbing the address is deliberate: the row's only two purposes
-- are the code exchange, which is over, and the uniqueness rule, which must stop
-- applying to an account that no longer exists.
--
-- ctl_tombstone_leaks_pii is extended rather than a new control being registered — its
-- subject is exactly this ("this account was erased but personal data remains"), and a
-- school email under a tombstone is that, plus the lockout.
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

-- ── The rows already stranded ───────────────────────────────────────────────
-- The change above only helps erasures from here on. Anyone who has already deleted
-- their account is holding both halves of the defect right now.
delete from public.student_email_verifications s
 using public.profiles p
 where p.id = s.user_id
   and p.deleted_at is not null;

-- ── The control notices a regression rather than waiting for a complaint ────
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
           'note', 'this account was erased but personal data remains on the profile row')
    from public.profiles p
   where p.deleted_at is not null
     and (p.name is distinct from 'Deleted user'
       or p.bio is not null
       or p.avatar_url is not null
       or p.city is not null
       or p.referral_code is not null
       or exists (select 1 from public.student_email_verifications s where s.user_id = p.id))
$$;

revoke execute on function public.ctl_tombstone_leaks_pii() from public, anon, authenticated;


-- ── Prove it, on a staged row, rolled back ──────────────────────────────────
--
-- The block has an EXCEPTION clause, which in PL/pgSQL is a savepoint — the deliberate
-- raise at the end rolls every write below back, tombstoned profile included.
do $$
declare
  uid uuid; uid2 uuid; probe_email text;
  blocked boolean := false; freed boolean := true; n int; leaks int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;
  -- A second account is the person re-registering. uniq_consumed_student_email is on
  -- the EMAIL alone, so one profile still demonstrates it if this is a fresh database.
  select id into uid2 from public.profiles where deleted_at is null and id <> uid limit 1;
  if uid2 is null then uid2 := uid; end if;

  probe_email := 'probe-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) || '@probe.edu';

  insert into public.student_email_verifications
    (user_id, email, domain, code_hash, expires_at, consumed)
  values (uid, probe_email, 'probe.edu', 'probe-hash', now() + interval '15 minutes', true);

  -- THE LOCKOUT, before the fix runs: while that row exists, the database itself
  -- refuses a second consumed verification of the same inbox. No amount of edge-function
  -- leniency could have unblocked this.
  begin
    insert into public.student_email_verifications
      (user_id, email, domain, code_hash, expires_at, consumed)
    values (uid2, probe_email, 'probe.edu', 'probe-hash-2', now() + interval '15 minutes', true);
    freed := true;
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'expected uniq_consumed_student_email to block the second account — '
                    'the lockout half of this finding cannot be demonstrated';
  end if;
  raise notice 'while the row survives, no other account can verify that inbox — that is the lockout';

  perform public.tombstone_profile(uid);

  -- The mechanism, stated as an assertion: the profile is KEPT, which is exactly why
  -- `on delete cascade` never reaches the verification row and the delete had to be
  -- written by hand.
  if not exists (select 1 from public.profiles where id = uid and deleted_at is not null) then
    raise exception 'tombstone_profile did not tombstone; the rest of this probe means nothing';
  end if;
  raise notice 'the profile row survives the erasure by design, so the FK cascade never fires';

  select count(*) into n from public.student_email_verifications where email = probe_email;
  if n <> 0 then
    raise exception 'FIX FAILED: % verification row(s) survived the erasure', n;
  end if;
  raise notice 'the erased account no longer carries its school email';

  -- And the person can verify that inbox again on a new account, which is the whole
  -- point of offering account deletion.
  begin
    insert into public.student_email_verifications
      (user_id, email, domain, code_hash, expires_at, consumed)
    values (uid2, probe_email, 'probe.edu', 'probe-hash-3', now() + interval '15 minutes', true);
  exception when unique_violation then
    freed := false;
  end;
  if not freed then
    raise exception 'the inbox is STILL blocked after erasure — re-registration remains impossible';
  end if;
  raise notice 'a new account can verify the same inbox: the start-fresh flow works again';

  -- The control now sees the state it could not see: a tombstone still holding one.
  delete from public.student_email_verifications where email = probe_email;
  select count(*) into leaks from public.ctl_tombstone_leaks_pii() where entity_id = uid::text;
  if leaks <> 0 then
    raise exception 'the control fires on a clean tombstone — that would be permanent noise';
  end if;
  insert into public.student_email_verifications
    (user_id, email, domain, code_hash, expires_at, consumed)
  values (uid, probe_email, 'probe.edu', 'probe-hash-4', now() + interval '15 minutes', true);
  select count(*) into leaks from public.ctl_tombstone_leaks_pii() where entity_id = uid::text;
  if leaks <> 1 then
    raise exception 'ctl_tombstone_leaks_pii reported % rows for a tombstone holding a school email', leaks;
  end if;
  raise notice 'the control reports a regression instead of waiting for someone to complain';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'student-email erasure probe passed; every staged row rolled back';
  else
    raise;
  end if;
end $$;
