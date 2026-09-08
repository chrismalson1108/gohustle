-- ─────────────────────────────────────────────────────────────────────────────
-- A waitlist, and the three ways one goes wrong (2026-09-08).
--
-- gohustlr.com has had no way to capture interest since it existed. The site's
-- every call to action points at /login?mode=signup, which is correct only while
-- signups are open — and they are, because beta_allowlist holds a '*' row
-- (20260710070000_open_beta_signups.sql). So today the site converts a visitor
-- into an account in an empty marketplace, and when the beta is re-closed by
-- deleting that row, every one of those buttons becomes a server-side raise with
-- no alternative offered.
--
-- This adds the missing surface. It is deliberately SMALL, and the cuts are the
-- design:
--
--   • NO PHONE COLUMN, and no SMS path anywhere. There is no provider in this
--     repo and 10DLC registration needs a registered entity; TCPA carries a
--     private right of action at $500/message. A column we cannot legally send to
--     is a liability with no upside.
--   • NO REFERRAL GRAPH. public.referrals FKs BOTH sides to public.profiles, so a
--     waitlist→waitlist edge cannot be stored at all, and bonus_cash_payout_enabled
--     is read by no code — a cash reward would vest to 'payable' and be
--     dischargeable by nothing. `source` (a ?src= parameter) answers the question
--     anyone actually asks of a waitlist: which channel worked.
--   • NO IP ON THE ROW. The per-caller bound lives in waitlist_attempts, which is
--     purged; the durable row for a person with no account and no accepted terms
--     holds no network identifier. Same split promo_redeem_attempts already uses.
--   • NO ZIP. There is one launch market, so a stored ZIP is a PII column whose
--     value is the same for every row the marketing will ever produce.
--     `in_launch_area` is derived in the browser and only the boolean is sent.
--   • NO CHANGE TO handle_new_user(). That function has been copy-forward
--     rewritten twice, the second time from live pg_proc rather than the previous
--     file, and losing its search_path, its signups_enabled check, its allowlist
--     check or the exact profile insert breaks account creation for EVERYONE. All
--     it would buy is a claimed_at column, and "did this person sign up?" is
--     answerable exactly as well by joining email against auth.users at read time
--     — which is what the console and ctl_waitlist_invite_broken below do.
--   • NO GUARD TRIGGER. RLS is on with zero policies and every grant is revoked
--     from anon and authenticated, so nothing but service_role can write here at
--     all (the beta_allowlist posture). A guard would pin columns against a policy
--     nobody has written, and would force the purge to claim service_role from
--     cron — which is precisely how expire_stale_pending_bookings silently never
--     ran between 2026-08-12 and 20260906042000.
--
-- What it DOES carry is the three things that go wrong with a waitlist, each
-- watched by a control against DATA rather than against the sending code being
-- written correctly:
--
--   1. You mail someone who opted out.       ctl_waitlist_emailed_after_optout
--   2. You tell someone they are invited     ctl_waitlist_invite_broken
--      and the gate does not agree.
--   3. Someone stuffs the list.              ctl_waitlist_signup_flood
--
-- The second is the one that is invisible everywhere else: an invite is a promise
-- made in an email and kept by a row in a DIFFERENT table, so nothing but a join
-- can tell you the promise was broken. It is deliberately silent while '*' stands
-- — with signups open, every invite is honoured by the '*' row and the control has
-- nothing to say. It arms itself the moment that row is deleted.
--
-- Idempotent. Ends with a rolled-back probe that stages one violation per control
-- and asserts each fires, then asserts each is silent on a healthy row.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The list ────────────────────────────────────────────────────────────────
create table if not exists public.waitlist (
  id                  uuid primary key default gen_random_uuid(),
  -- Normalised by trg_a_normalize_waitlist_email below, then uniquely indexed, so
  -- one inbox is one row no matter how it was typed. That unique index IS the
  -- per-address rate limit: a repeat submission conflicts instead of accumulating.
  email               text        not null,
  role_intent         text        not null default 'both'
                        check (role_intent in ('earn', 'post', 'both')),
  -- ?src=ulm-flyer / ig-bio / kappa-sigma. The whole attribution story, and the
  -- reason no referral schema exists here. Capped and stripped by the trigger.
  source              text,
  -- Derived in the browser from a ZIP that is never transmitted. Nullable because
  -- somebody can join without answering.
  in_launch_area      boolean,
  -- ONE token, hashed, serving BOTH confirm and unsubscribe. Not salted, and that
  -- is deliberate: student_email_verifications salts because a 6-digit code lives
  -- in a 900,000-wide space and is grindable. This is 32 bytes from a CSPRNG — the
  -- hash exists so a database leak does not yield working unsubscribe links, not to
  -- resist a dictionary that cannot exist. No expires_at and no attempt counter for
  -- the same reason: both would add live failure modes ("my link expired", "too many
  -- attempts" on a link somebody clicked twice) and no attacker cost.
  token_hash          text        not null,
  -- Address ownership proven by a click. NOT a gate on membership: a rotated Resend
  -- key or a deliverability problem would otherwise produce a full table and an empty
  -- export. It is the default invite predicate and a quality signal, not the record
  -- of consent — consent is the submission itself, under the sentence recorded in
  -- consent_doc_version.
  confirmed_at        timestamptz,
  -- CAN-SPAM opt-out. The row is SCRUBBED rather than deleted, because honouring an
  -- opt-out forever requires keeping the address to suppress it.
  unsubscribed_at     timestamptz,
  -- A lifetime cap, not a cooldown. A 10-minute floor still lets one address be
  -- mailed 144 times a day by an attacker who types it into the form; this makes the
  -- confirmation email a once-per-address event for the life of the row.
  email_sent_count    integer     not null default 0,
  last_email_sent_at  timestamptz,
  invited_at          timestamptz,
  -- Free text, e.g. 'wave-1' — the only feedback loop that lets wave 2 correct the
  -- earner:poster ratio of who actually claimed in wave 1.
  invite_wave         text,
  -- Which published privacy version the consent sentence pointed at. The consent
  -- record is this plus created_at; a sha256 of the sentence would be a hash nothing
  -- ever compares against.
  consent_doc_version text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.waitlist is
  'Pre-launch interest capture from gohustlr.com. One row per email address. '
  'Written ONLY by the waitlist-submit edge function under service_role — RLS is '
  'on with no policies and all grants are revoked from anon/authenticated.';

create unique index if not exists waitlist_email_key on public.waitlist (email);
create unique index if not exists waitlist_token_hash_key on public.waitlist (token_hash);
create index if not exists waitlist_created_idx on public.waitlist (created_at desc);
-- The invite queue's own predicate, so the console's default tab is an index scan
-- rather than a filter over the table.
create index if not exists waitlist_pending_invite_idx on public.waitlist (created_at)
  where confirmed_at is not null and invited_at is null and unsubscribed_at is null;

-- ── The attempt ledger ──────────────────────────────────────────────────────
-- One row per SUBMISSION, regardless of outcome — the promo_redeem_attempts shape,
-- and for the same reason: a sweep that only ever conflicts on the unique email
-- index would never register if the count were taken from the durable table.
--
-- ip_hash, never the address. It is a bound on a caller, not a record of a person,
-- and it is purged with everything else older than 48 hours.
create table if not exists public.waitlist_attempts (
  id         bigserial primary key,
  email      text,
  ip_hash    text,
  created_at timestamptz not null default now()
);
create index if not exists waitlist_attempts_ip_idx on public.waitlist_attempts (ip_hash, created_at desc);
create index if not exists waitlist_attempts_created_idx on public.waitlist_attempts (created_at);

comment on table public.waitlist_attempts is
  'Rate-limit ledger for waitlist-submit. One row per attempt regardless of outcome. '
  'Holds a HASH of the caller IP, never the address, and is purged at 48 hours.';

-- ── Normalisation, in the database ──────────────────────────────────────────
-- Not in the caller. The same argument as trg_y_normalize_job_category: the web
-- form is one writer today and will not be the only one, and "one inbox is one row"
-- has to be true of every write or the unique index above is decoration.
--
-- The +tag strip matches normalizeEduEmail in student-verify-start: a+1@x.com and
-- a+2@x.com are one mailbox, and treating them as two is how one person occupies
-- fifty rows of a cohort count.
create or replace function public.normalize_waitlist_row()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(coalesce(new.email, '')));
  if position('+' in split_part(new.email, '@', 1)) > 0 then
    new.email := split_part(split_part(new.email, '@', 1), '+', 1)
                 || '@' || split_part(new.email, '@', 2);
  end if;
  -- A source is an attribution slug, not free text. Anything else is somebody
  -- putting a sentence in a query string that an operator will later read.
  new.source := nullif(left(regexp_replace(coalesce(new.source, ''), '[^a-zA-Z0-9_.-]', '', 'g'), 40), '');
  new.invite_wave := nullif(left(btrim(coalesce(new.invite_wave, '')), 40), '');
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.normalize_waitlist_row() from public, anon, authenticated;

drop trigger if exists trg_a_normalize_waitlist_email on public.waitlist;
create trigger trg_a_normalize_waitlist_email
  before insert or update on public.waitlist
  for each row execute function public.normalize_waitlist_row();

-- ── Posture ─────────────────────────────────────────────────────────────────
-- RLS on, zero policies, every grant revoked: the beta_allowlist and
-- student_email_verifications posture. Nothing reaches this table but service_role
-- (the edge function and the console) and SECURITY DEFINER functions. A client
-- cannot enumerate who has signed up, and there is no policy for a guard to defend.
alter table public.waitlist enable row level security;
alter table public.waitlist_attempts enable row level security;

revoke all on public.waitlist from anon, authenticated;
revoke all on public.waitlist_attempts from anon, authenticated;
grant all on public.waitlist to service_role;
grant all on public.waitlist_attempts to service_role;
grant usage, select on sequence public.waitlist_attempts_id_seq to service_role;

-- ── The kill switch ─────────────────────────────────────────────────────────
-- app_flag() returns TRUE for an unknown key, so adding this check to the edge
-- function can never take the form down by itself.
insert into public.app_flags (key, enabled, value, note)
values (
  'waitlist_enabled',
  true,
  '{}'::jsonb,
  'Master switch for the public waitlist form on gohustlr.com. OFF = waitlist-submit '
  'refuses new joins and the form says so. Confirm and unsubscribe keep working while '
  'it is off — an opt-out must never be blocked by a feature flag.'
)
on conflict (key) do nothing;

-- ── Retention ───────────────────────────────────────────────────────────────
-- Two rules, and only one of them needs a scheduler.
--
-- The privacy-critical half — scrubbing an unsubscribed row down to a bare
-- suppression record — is done by the edge function inside the unsubscribe request
-- itself, so honouring an opt-out never depends on cron running. This function only
-- carries the parts that can wait: expiring stale unconfirmed rows, and clearing the
-- attempt ledger.
--
-- No service_role claim is needed here and that is not an oversight: without a guard
-- trigger there is no deny-by-default to trip, so this runs cleanly from pg_cron with
-- no JWT. That is the whole reason the guard was left out.
create or replace function public.purge_waitlist_expired()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  m int;
begin
  -- Someone who never confirmed, 180 days on, is not a lead. Long enough that a
  -- launch slipping two quarters does not silently delete the list.
  delete from public.waitlist
   where confirmed_at is null
     and unsubscribed_at is null
     and invited_at is null
     and created_at < now() - interval '180 days';
  get diagnostics n = row_count;

  delete from public.waitlist_attempts where created_at < now() - interval '48 hours';
  get diagnostics m = row_count;

  return n + m;
end;
$$;

revoke execute on function public.purge_waitlist_expired() from public, anon, authenticated;
grant execute on function public.purge_waitlist_expired() to service_role;

-- ── Erasure ─────────────────────────────────────────────────────────────────
-- A person who joined the waitlist, signed up, and then deleted their account still
-- has their address sitting here. The FK cascade cannot reach it because there is no
-- FK — the waitlist is keyed on an email, not a user.
--
-- Re-typed in full from 20260906025200 (the live body), with one delete added. It
-- must read auth.users BEFORE delete-account's step 5 rewrites that email to
-- deleted-<uuid>@removed.invalid; tombstone_profile is called at index.ts:350 and
-- updateUserById at :384, so it does.
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

  -- The waitlist row for this person's address. Added 2026-09-08 with the waitlist:
  -- an erased account whose email is still on a marketing list is the same failure as
  -- the .edu row below, one table over.
  delete from public.waitlist w
   using auth.users u
   where u.id = p_user
     and w.email = lower(u.email);

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

-- Accounts already erased before this shipped. Their auth email has been rewritten
-- to deleted-<uuid>@removed.invalid, so match on that instead — it carries the id.
delete from public.waitlist w
 using auth.users u, public.profiles p
 where p.id = u.id
   and p.deleted_at is not null
   and w.email = lower(u.email);

-- ── Control 1: we mailed somebody who opted out ─────────────────────────────
-- CRITICAL, because it is the one promise in this feature that is made to a person
-- who has no account, no support thread and no other way to make us stop. It asserts
-- against DATA — the two timestamps on the row — rather than against the send code
-- having been written correctly, which is the standard the money paths are already
-- held to here.
create or replace function public.ctl_waitlist_emailed_after_optout()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select w.id::text,
         jsonb_build_object(
           'kind', 'emailed_after_optout',
           'email', w.email,
           'unsubscribed_at', w.unsubscribed_at,
           'last_email_sent_at', w.last_email_sent_at,
           'email_sent_count', w.email_sent_count,
           'remedy', 'Stop the send that did this, then confirm the address is suppressed. '
                     || 'An opt-out honoured late is still an opt-out broken.'
         )
    from public.waitlist w
   where w.unsubscribed_at is not null
     and w.last_email_sent_at is not null
     and w.last_email_sent_at > w.unsubscribed_at;
$$;

-- ── Control 2: we said "you're invited" and the gate disagrees ──────────────
-- An invite is a promise made in an email and kept by a row in beta_allowlist. If
-- the two disagree, the person clicks the link in good faith and handle_new_user
-- raises signup_not_allowlisted at the auth layer — a server-side refusal no client
-- test can find, because every developer's own address is already on the list.
--
-- Deliberately silent while the '*' row stands: with signups open every invite is
-- honoured, so there is nothing to report. It arms itself the moment that row is
-- deleted, which is exactly when the failure becomes possible.
create or replace function public.ctl_waitlist_invite_broken()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select w.id::text,
         jsonb_build_object(
           'kind', 'invited_but_not_allowlisted',
           'email', w.email,
           'invited_at', w.invited_at,
           'invite_wave', w.invite_wave,
           'remedy', 'Add this address in /access (or re-run the invite from /waitlist). '
                     || 'Until then their signup is refused server-side with no explanation.'
         )
    from public.waitlist w
   where w.invited_at is not null
     -- Not yet an account, so the broken promise is still live.
     and not exists (select 1 from auth.users u where lower(u.email) = w.email)
     -- Signups are closed: no blanket row.
     and not exists (select 1 from public.beta_allowlist b where b.email = '*')
     and not exists (
       select 1 from public.beta_allowlist b where lower(b.email) = w.email
     );
$$;

-- ── Control 3: somebody is stuffing the list ────────────────────────────────
-- The other two are post-hoc; neither can see a stuffing run while it is happening.
-- Two namespaced arms so one entity is never returned twice — run_control merges
-- duplicates now (20260906045000), but a control that relies on the net is a control
-- whose findings read worse than they need to.
create or replace function public.ctl_waitlist_signup_flood()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select 'global:last_hour' as entity_id,
         jsonb_build_object(
           'kind', 'global_flood',
           'rows_last_hour', count(*),
           'remedy', 'Check /waitlist for junk addresses, then turn waitlist_enabled off '
                     || 'in /flags while you look. The rows are kept either way.'
         )
    from public.waitlist
   where created_at > now() - interval '1 hour'
  having count(*) > 150

  union all

  select 'ip:' || a.ip_hash,
         jsonb_build_object(
           'kind', 'one_caller_flood',
           'attempts_last_hour', count(*),
           'remedy', 'One caller. The per-IP cap in waitlist-submit should have refused '
                     || 'these — if it did, this is the record of an attempt, not a breach.'
         )
    from public.waitlist_attempts a
   where a.created_at > now() - interval '1 hour'
     and a.ip_hash is not null
   group by a.ip_hash
  having count(*) > 40;
$$;

revoke execute on function public.ctl_waitlist_emailed_after_optout() from public, anon, authenticated;
revoke execute on function public.ctl_waitlist_invite_broken() from public, anon, authenticated;
revoke execute on function public.ctl_waitlist_signup_flood() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('waitlist_emailed_after_optout',
   'A waitlist address was emailed after it opted out',
   'critical', 'security',
   'The unsubscribe link is the only way a person with no account can make us stop, '
   'and it is a promise made in writing in every message we send them. Nothing else '
   'watches it: the send path is an inline Resend fetch inside one edge function, so '
   '"we checked unsubscribed_at first" is a property of code nobody re-reads. This '
   'compares the two timestamps on the row instead, which is true or false regardless '
   'of how the send was written.',
   'ctl_waitlist_emailed_after_optout'),

  ('waitlist_invite_broken',
   'Someone was told they are invited and the signup gate does not agree',
   'high', 'integrity',
   'An invite is a promise made in an email and kept by a row in a DIFFERENT table. '
   'If /waitlist stamps invited_at and the beta_allowlist upsert did not land, the '
   'person clicks the link and handle_new_user raises signup_not_allowlisted at the '
   'auth layer — a rollback with no message, which reads to them as the app being '
   'broken. No client test can find it, because every developer address is already '
   'allowlisted. Silent while the ''*'' row stands, by design.',
   'ctl_waitlist_invite_broken'),

  ('waitlist_signup_flood',
   'The waitlist is being stuffed',
   'high', 'abuse',
   'waitlist-submit is public by necessity and its caps are per-address and per-IP. '
   'Neither bounds a botnet sending distinct addresses from rotating hosts, and the '
   'damage is not the rows — it is that the cohort counts the launch waves are sized '
   'from become fiction, and that GoHustlr''s sending domain mails strangers who never '
   'asked. This is the only arm of the three that can see it while it is happening.',
   'ctl_waitlist_signup_flood')
on conflict (key) do update
  set title = excluded.title, severity = excluded.severity, domain = excluded.domain,
      why = excluded.why, fn_name = excluded.fn_name;

-- ── Probe ───────────────────────────────────────────────────────────────────
-- Stage one violation per control, assert each fires and names the row, then assert
-- each is silent on a healthy row. Rolled back.
do $$
declare
  bad_optout  uuid;
  bad_invite  uuid;
  healthy     uuid;
  n           int;
begin
  -- 1. Normalisation. One inbox, typed three ways, is one row.
  insert into public.waitlist (email, role_intent, token_hash)
  values ('  Probe.Person+ULM@Example.COM ', 'earn', 'probe-token-hash-1')
  returning id into healthy;
  if (select email from public.waitlist where id = healthy) <> 'probe.person@example.com' then
    raise exception 'FIX FAILED: normalisation left % ', (select email from public.waitlist where id = healthy);
  end if;
  begin
    insert into public.waitlist (email, token_hash)
    values ('PROBE.PERSON@example.com', 'probe-token-hash-dup');
    raise exception 'FIX FAILED: a second row was accepted for the same normalised inbox';
  exception when unique_violation then
    null; -- expected
  end;

  -- 1b. A source is a slug, not a sentence.
  update public.waitlist set source = 'ulm flyer <b>&</b> friends; 100% off!' where id = healthy;
  if (select source from public.waitlist where id = healthy) ~ '[^a-zA-Z0-9_.-]' then
    raise exception 'FIX FAILED: source kept characters the trigger should have stripped: %',
      (select source from public.waitlist where id = healthy);
  end if;

  -- 2. Control 1 — emailed after opt-out.
  insert into public.waitlist (email, token_hash, unsubscribed_at, last_email_sent_at, email_sent_count)
  values ('probe.optout@example.com', 'probe-token-hash-2',
          now() - interval '2 hours', now() - interval '1 hour', 2)
  returning id into bad_optout;

  select count(*) into n from public.ctl_waitlist_emailed_after_optout() where entity_id = bad_optout::text;
  if n <> 1 then
    raise exception 'FIX FAILED: emailed-after-optout did not report the staged row (got % rows)', n;
  end if;
  select count(*) into n from public.ctl_waitlist_emailed_after_optout() where entity_id = healthy::text;
  if n <> 0 then
    raise exception 'FIX FAILED: emailed-after-optout reported a healthy row';
  end if;
  raise notice 'ctl_waitlist_emailed_after_optout: fires on the violation, silent on the healthy row';

  -- 3. Control 2 — invited but not allowlisted. Only assertable with '*' removed,
  --    which is the state the control exists for. Remove it inside this transaction.
  delete from public.beta_allowlist where email = '*';

  insert into public.waitlist (email, token_hash, confirmed_at, invited_at, invite_wave)
  values ('probe.invited@example.com', 'probe-token-hash-3', now(), now(), 'probe-wave')
  returning id into bad_invite;

  select count(*) into n from public.ctl_waitlist_invite_broken() where entity_id = bad_invite::text;
  if n <> 1 then
    raise exception 'FIX FAILED: invite-broken did not report an invited, un-allowlisted address (got %)', n;
  end if;

  -- Put the address on the gate and the finding must disappear. This is the
  -- discrimination that matters: the control tracks the JOIN, not the timestamp.
  insert into public.beta_allowlist (email, note) values ('probe.invited@example.com', 'probe');
  select count(*) into n from public.ctl_waitlist_invite_broken() where entity_id = bad_invite::text;
  if n <> 0 then
    raise exception 'FIX FAILED: invite-broken still fires after the address was allowlisted';
  end if;

  -- And it must go silent entirely while signups are open, however many rows are
  -- staged — otherwise it would page every day of a beta that is not closed.
  delete from public.beta_allowlist where email = 'probe.invited@example.com';
  insert into public.beta_allowlist (email, note) values ('*', 'probe');
  select count(*) into n from public.ctl_waitlist_invite_broken();
  if n <> 0 then
    raise exception 'FIX FAILED: invite-broken fires while the ''*'' row makes every invite real (% findings)', n;
  end if;
  raise notice 'ctl_waitlist_invite_broken: fires when the gate disagrees, silent once allowlisted, silent while ''*'' stands';

  -- 4. Control 3 — one caller flooding.
  insert into public.waitlist_attempts (email, ip_hash)
  select 'probe' || g || '@example.com', 'probe-ip-hash' from generate_series(1, 41) g;
  select count(*) into n from public.ctl_waitlist_signup_flood() where entity_id = 'ip:probe-ip-hash';
  if n <> 1 then
    raise exception 'FIX FAILED: signup-flood did not report 41 attempts from one caller (got %)', n;
  end if;
  delete from public.waitlist_attempts where ip_hash = 'probe-ip-hash' and id in (
    select id from public.waitlist_attempts where ip_hash = 'probe-ip-hash' limit 2
  );
  select count(*) into n from public.ctl_waitlist_signup_flood() where entity_id = 'ip:probe-ip-hash';
  if n <> 0 then
    raise exception 'FIX FAILED: signup-flood still fires at 39 attempts, under the threshold';
  end if;
  raise notice 'ctl_waitlist_signup_flood: fires at 41 attempts from one caller, silent at 39';

  -- 5. The purge keeps what it should and drops what it should.
  update public.waitlist set created_at = now() - interval '200 days' where id = healthy;
  update public.waitlist set created_at = now() - interval '200 days' where id = bad_optout;
  perform public.purge_waitlist_expired();
  if exists (select 1 from public.waitlist where id = healthy) then
    raise exception 'FIX FAILED: an unconfirmed 200-day-old row survived the purge';
  end if;
  if not exists (select 1 from public.waitlist where id = bad_optout) then
    raise exception 'FIX FAILED: the purge deleted an unsubscribed row — the suppression list must survive';
  end if;
  raise notice 'purge_waitlist_expired: drops stale unconfirmed rows, keeps the suppression list';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'waitlist probe passed — every control discriminates, all changes rolled back';
  else
    raise;
  end if;
end $$;

-- Post-deploy, run once by hand and expect zero rows from each:
--   select * from public.ctl_waitlist_emailed_after_optout();
--   select * from public.ctl_waitlist_invite_broken();
--   select * from public.ctl_waitlist_signup_flood();
