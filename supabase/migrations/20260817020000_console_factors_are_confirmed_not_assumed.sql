-- ─────────────────────────────────────────────────────────────────────────────
-- The human confirmation that guards the console was never recorded, and nothing
-- noticed when it was owed.
--
-- 20260804030000 built the pending→active status around one instruction: activate only
-- after the person has enrolled and you have "confirmed the enrolment time with them
-- directly — the sign-in page will enrol a factor for whoever knows the password, so that
-- confirmation is the actual control."
--
-- It is the actual control and it lived entirely in prose. Two holes fell out of that on
-- 2026-08-17:
--
-- 1. NOBODY IS TOLD THE CONFIRMATION IS OWED. A newly invited admin enrolled his
--    authenticator and then sat at a denial screen until he texted the founder. The
--    person who has to act is the only one not informed; the pending row is visible only
--    to someone who happens to open /team. An invite that stalls forever is not a
--    security failure, but it is how a real person concludes the tool is broken and
--    starts making second accounts — which he offered to do, in writing.
--
-- 2. THE CONFIRMATION LEAVES NO TRACE, so a factor appearing LATER is indistinguishable
--    from the one that was vouched for. Activate is a single click on a row whose
--    timestamp nobody records agreeing to. If a second authenticator is enrolled on an
--    active console account a week afterwards — which is exactly what a stolen password
--    buys, since /mfa enrols for whoever presents one — no query anywhere can tell it
--    from the original.
--
-- ── WHY NOT SIMPLY ALERT ON "MORE THAN ONE FACTOR" ──────────────────────────
-- Because that is a legitimate steady state and the alert could never be resolved. The
-- app enrols as 'GoHustlr' and the console as 'GoHustlr Admin', so anyone who uses both
-- surfaces holds two factors permanently and correctly. A control that fires forever on
-- a healthy account is the permanent-false-positive failure this project has now fixed
-- three times (ctl_admin_without_mfa, ctl_discount_without_grant,
-- ctl_stripe_id_mode_mismatch) — it teaches people the board lies, which costs more than
-- the control is worth.
--
-- So record the confirmation instead. `factors_confirmed_at` is stamped when an admin
-- activates a member, and the control asks whether any factor is NEWER than that stamp.
-- A second authenticator the reviewer has accounted for clears with one click; one that
-- appears afterwards stays open until a human looks at it. The signal is "unreviewed",
-- not "unusual", and unreviewed is a state that can actually be closed.
--
-- Existing active members are backfilled to now(): today's factors are the known-good
-- baseline, confirmed by the two people who hold them, and starting the control with a
-- backlog it cannot explain would be the same false-positive mistake in a new coat.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.admin_users add column if not exists factors_confirmed_at timestamptz;

comment on column public.admin_users.factors_confirmed_at is
  'When an admin last vouched for every authenticator on this account. Stamped by '
  'Activate and by the Confirm authenticators action. ctl_admin_unconfirmed_factor '
  'fires on any verified factor created after it.';

update public.admin_users
   set factors_confirmed_at = now()
 where status = 'active' and factors_confirmed_at is null;


-- ── 1. Somebody did their part and is waiting on us ─────────────────────────
create or replace function public.ctl_admin_pending_enrolled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select a.user_id::text,
         jsonb_build_object(
           'kind', 'pending_enrolled',
           'email', u.email::text,
           'role', a.role,
           'added_at', a.created_at,
           'enrolled_at', f.enrolled_at,
           'waiting_hours', round(extract(epoch from now() - f.enrolled_at) / 3600),
           'note', 'this person has enrolled an authenticator and is sitting at a '
                   'denial screen. The pending row grants nothing until an admin '
                   'activates it, and nothing tells the admin it is owed — so the '
                   'usual outcome is that they give up or try a second account.',
           'remedy', 'Open /team, confirm the enrolment time above with them directly, '
                     'then press Activate. If the time is not one they recognise, press '
                     'Reset authenticator instead and have them change their password.'
         )
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    join lateral (
      select max(mf.created_at) as enrolled_at, count(*) as n
        from auth.mfa_factors mf
       where mf.user_id = a.user_id and mf.status = 'verified'
    ) f on f.n > 0
   where a.status = 'pending'
     -- Twelve hours, not one: a same-day activation is the normal path and must not
     -- page anybody. This is for the invite that quietly stalls.
     and f.enrolled_at < now() - interval '12 hours'
$$;

revoke execute on function public.ctl_admin_pending_enrolled() from public, anon, authenticated;


-- ── 2. A factor nobody has vouched for ──────────────────────────────────────
create or replace function public.ctl_admin_unconfirmed_factor()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select a.user_id::text,
         jsonb_build_object(
           'kind', 'unconfirmed_factor',
           'email', u.email::text,
           'role', a.role,
           'confirmed_at', a.factors_confirmed_at,
           'factors', f.list,
           'note', 'an authenticator on this console account is newer than the last '
                   'time an admin vouched for it. /mfa enrols a fresh factor for '
                   'whoever presents the password, so a factor appearing after '
                   'activation is what a stolen password buys — and it is also what a '
                   'legitimate second device looks like. A human has to say which.',
           'remedy', 'Open /team. If every authenticator listed on the row is accounted '
                     'for by the person, press Confirm authenticators. If any is not, '
                     'press Reset authenticator — that removes them all and drops the '
                     'member back to pending — and have them change their password.'
         )
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    join lateral (
      select max(mf.created_at) as newest,
             jsonb_agg(jsonb_build_object('name', mf.friendly_name, 'created_at', mf.created_at)
                       order by mf.created_at) as list
        from auth.mfa_factors mf
       where mf.user_id = a.user_id and mf.status = 'verified'
    ) f on f.newest is not null
   where a.status = 'active'
     -- A NULL stamp means nobody has ever vouched. Treated as unconfirmed rather than
     -- as confirmed: failing open here would make the control silent on exactly the
     -- accounts it knows least about.
     and (a.factors_confirmed_at is null or f.newest > a.factors_confirmed_at)
$$;

revoke execute on function public.ctl_admin_unconfirmed_factor() from public, anon, authenticated;


-- ── Register both, or run_all_controls never runs them ──────────────────────
-- The registry IS the roster: run_all_controls iterates it, so an unregistered ctl_
-- function is a check that never fires while the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('admin_pending_enrolled',
   'Invited admin has enrolled and is waiting on activation',
   'medium', 'security',
   'They have done their part and are sitting at a denial screen. The pending row is '
   'correct and grants nothing — but nothing tells the admin the confirmation is owed, '
   'so the invite stalls until the person chases it or gives up and tries a second '
   'account. Twelve hours, so a same-day activation never pages anybody.',
   'ctl_admin_pending_enrolled'),
  ('admin_unconfirmed_factor',
   'Console account carries an authenticator nobody has vouched for',
   'high', 'security',
   'The sign-in page enrols a fresh authenticator for whoever presents the password, so '
   'a factor appearing after activation is precisely what a stolen password buys. It is '
   'also what a legitimate second device looks like, which is why this asks for a human '
   'decision rather than guessing: confirm it, or reset it and change the password. '
   'Deliberately NOT "more than one factor" — the app and the console enrol under '
   'different names, so two is a normal steady state and would be permanent noise.',
   'ctl_admin_unconfirmed_factor')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── /team needs the stamp too, or the console cannot show what the control sees ──
-- A control that fires on a state the operator's own screen does not render sends them
-- looking for something they cannot find. Same reason the factor list went on the row.
drop function if exists public.admin_team_list();

create or replace function public.admin_team_list()
returns table (
  user_id              uuid,
  email                text,
  name                 text,
  role                 text,
  status               text,
  mfa_enrolled_at      timestamptz,
  mfa_factor_count     integer,
  mfa_factors          jsonb,
  factors_confirmed_at timestamptz,
  created_at           timestamptz,
  disabled_at          timestamptz,
  note                 text
)
language sql
security definer
stable
set search_path = public
as $$
  select a.user_id, u.email::text, p.name, a.role, a.status,
         f.enrolled_at,
         coalesce(f.n, 0),
         coalesce(f.list, '[]'::jsonb),
         a.factors_confirmed_at,
         a.created_at, a.disabled_at, a.note
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
    left join lateral (
      select max(mf.created_at) as enrolled_at,
             count(*)::int      as n,
             jsonb_agg(
               jsonb_build_object('name', mf.friendly_name, 'created_at', mf.created_at)
               order by mf.created_at
             ) as list
        from auth.mfa_factors mf
       where mf.user_id = a.user_id
         and mf.status = 'verified'
    ) f on true
   order by (a.status = 'active') desc, a.created_at
$$;

revoke execute on function public.admin_team_list() from public, anon, authenticated;
grant execute on function public.admin_team_list() to service_role;


-- ── Prove both fire, and both go quiet for the right reason ─────────────────
do $$
declare
  uid uuid;
  has_secret boolean;
  n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select u.id into uid
    from auth.users u
    join public.profiles p on p.id = u.id and p.deleted_at is null
   where not exists (select 1 from public.admin_users a where a.user_id = u.id)
     and not exists (
       select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')
   limit 1;
  if uid is null then raise exception 'no unenrolled non-admin account to stage against'; end if;

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'mfa_factors' and column_name = 'secret'
  ) into has_secret;

  -- ── pending_enrolled ──────────────────────────────────────────────────────
  insert into public.admin_users (user_id, role, status) values (uid, 'support', 'pending');

  -- Pending with NO factor: silent. They have not done their part yet, and a pending
  -- row grants nothing, so there is nothing for a human to act on.
  select count(*) into n from public.ctl_admin_pending_enrolled() where entity_id = uid::text;
  if n <> 0 then raise exception 'fired on a pending member with no factor'; end if;

  -- Enrolled ONE HOUR ago: still silent. A same-day activation is the normal path.
  if has_secret then
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr Admin', 'totp', 'verified', 'PROBEONLYNOTASECRET',
            now() - interval '1 hour', now());
  else
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr Admin', 'totp', 'verified', now() - interval '1 hour', now());
  end if;
  select count(*) into n from public.ctl_admin_pending_enrolled() where entity_id = uid::text;
  if n <> 0 then raise exception 'fired one hour in — this would page on every normal invite'; end if;
  raise notice 'a fresh pending enrolment is silent, so same-day activation never pages';

  -- Aged past the threshold: fires.
  update auth.mfa_factors set created_at = now() - interval '30 hours' where user_id = uid;
  select count(*) into n from public.ctl_admin_pending_enrolled() where entity_id = uid::text;
  if n <> 1 then raise exception 'FIX FAILED: a 30-hour-old pending enrolment reported % rows', n; end if;
  raise notice 'a pending member waiting 30 hours is now visible without anyone opening /team';

  -- ── unconfirmed_factor ────────────────────────────────────────────────────
  -- Activate them WITHOUT stamping: this is the pre-migration world, and the control
  -- must treat "nobody ever vouched" as unconfirmed rather than fail open.
  update public.admin_users set status = 'active', factors_confirmed_at = null where user_id = uid;
  select count(*) into n from public.ctl_admin_unconfirmed_factor() where entity_id = uid::text;
  if n <> 1 then raise exception 'FIX FAILED: a never-vouched-for account reported % rows', n; end if;
  raise notice 'a factor nobody has ever vouched for is unconfirmed, not assumed good';

  -- Confirmed now: quiet.
  update public.admin_users set factors_confirmed_at = now() where user_id = uid;
  select count(*) into n from public.ctl_admin_unconfirmed_factor() where entity_id = uid::text;
  if n <> 0 then raise exception 'still open after confirmation — this control could never be closed'; end if;
  raise notice 'confirming clears it, so the finding is resolvable rather than permanent noise';

  -- A SECOND factor enrolled afterwards: fires again. This is the stolen-password shape,
  -- and the one thing a bare "more than one factor" test could not distinguish from the
  -- legitimate app-plus-console pair that is already sitting on this row.
  if has_secret then
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr', 'totp', 'verified', 'PROBEONLYNOTASECRET2',
            now() + interval '1 minute', now());
  else
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr', 'totp', 'verified', now() + interval '1 minute', now());
  end if;
  select count(*) into n from public.ctl_admin_unconfirmed_factor() where entity_id = uid::text;
  if n <> 1 then raise exception 'FIX FAILED: a factor added after confirmation reported % rows', n; end if;
  raise notice 'a factor appearing AFTER the confirmation re-opens it — which is the stolen-password shape';

  -- And an unverified factor never counts, on either control.
  update auth.mfa_factors set status = 'unverified' where user_id = uid;
  select count(*) into n from public.ctl_admin_unconfirmed_factor() where entity_id = uid::text;
  if n <> 0 then raise exception 'an unverified factor was treated as an authenticator'; end if;
  raise notice 'unverified factors count for neither control';

  -- Both are registered, or run_all_controls never reaches them.
  select count(*) into n from public.controls
   where key in ('admin_pending_enrolled', 'admin_unconfirmed_factor')
     and enabled and not external;
  if n <> 2 then raise exception 'only % of 2 controls are registered and enabled', n; end if;
  raise notice 'both registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'admin MFA visibility probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
