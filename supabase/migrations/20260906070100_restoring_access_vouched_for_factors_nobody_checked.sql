-- ─────────────────────────────────────────────────────────────────────────────
-- Restoring a revoked admin recorded a human confirmation that no human was asked for.
--
-- 20260817020000 made `factors_confirmed_at` the thing ctl_admin_unconfirmed_factor
-- compares against: it fires on any verified factor NEWER than the last time an admin
-- vouched for the account's authenticators. The console stamps it from
-- setTeamStatus, on the reasoning that "Activating IS the confirmation" — which is true
-- of the pending→active click, whose dialog prints the factor count, the enrolment time,
-- and "Confirm that time with them directly".
--
-- The same server action also serves RESTORE, and its dialog said only "Restore access
-- for X?". No factor list, no enrolment time, no instruction to check anything. That
-- click stamped the column too, so the console certified factors nobody had looked at.
--
-- ── WHY THE REVOKED ACCOUNT IS THE WORST ONE TO GUESS ABOUT ─────────────────
-- A disabled row is the account nobody is watching. It grants nothing, so no session of
-- its own raises an alarm; /mfa still enrols a fresh authenticator for whoever presents
-- the password; ctl_admin_unconfirmed_factor filters to `a.status = 'active'` and cannot
-- see it; and resetAuthenticator demotes only ACTIVE targets, so a reset performed to
-- help a departing person leaves a disabled, factorless row that anyone with the
-- password can enrol against. Then Restore stamps factors_confirmed_at = now(), which is
-- newer than that factor, and the control is silent on the one account it should have
-- caught. The /team row showed no warning either — needsConfirm keys on the same column.
--
-- ── THE FIX, IN TWO HALVES ──────────────────────────────────────────────────
-- The console half (admin/app/(console)/team/actions.ts) stamps only on pending→active
-- and leaves the column alone on disabled→active, so a restored row comes back
-- unconfirmed: the control fires and "Confirm authenticators" appears. The dialog now
-- names the factor count and the newest enrolment time and says restoring vouches for
-- nothing.
--
-- This is the other half, and it is the durable one. The console is not the only writer
-- of this table — service_role is — and the stamp has already been written by a click
-- that did not ask once. A BEFORE UPDATE trigger refuses to let a disabled→active
-- transition ADVANCE the confirmation: whatever the row was vouched for before the
-- revocation (normally nothing, because leaving active clears it) is what it is vouched
-- for after. It pins rather than raising, because restoring someone's access is an
-- availability path and must not fail; the invariant is preserved either way, and the
-- control does the shouting.
--
-- Nothing else is touched: pending→active still stamps, and confirmAuthenticators — an
-- update that leaves status alone — still stamps, because that click IS the confirmation.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_restore_never_vouches()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Only the restore transition, and only when it tries to move the stamp forward.
  if old.status = 'disabled'
     and new.status = 'active'
     and new.factors_confirmed_at is distinct from old.factors_confirmed_at then
    new.factors_confirmed_at := old.factors_confirmed_at;
  end if;
  return new;
end;
$$;

comment on function public.admin_restore_never_vouches() is
  'Restoring a revoked console account restores ACCESS, never the confirmation of its '
  'authenticators. A factor can be enrolled while a row is disabled — /mfa enrols for '
  'whoever holds the password, and nothing watches a row that grants nothing — so a '
  'stamp written by the Restore click would certify a factor no human ever saw, and '
  'ctl_admin_unconfirmed_factor compares against exactly that stamp.';

drop trigger if exists trg_admin_restore_never_vouches on public.admin_users;
create trigger trg_admin_restore_never_vouches
  before update on public.admin_users
  for each row execute function public.admin_restore_never_vouches();

comment on column public.admin_users.factors_confirmed_at is
  'When an admin last vouched for every authenticator on this account. Stamped by '
  'Activate (pending -> active, whose dialog names the enrolment time) and by the '
  'Confirm authenticators action. NOT by Restore: trg_admin_restore_never_vouches pins '
  'it across disabled -> active. ctl_admin_unconfirmed_factor fires on any verified '
  'factor created after it, and on a null.';


-- ── Prove it discriminates: the same UPDATE, two prior statuses ─────────────
-- One staged row is activated out of `pending` and one out of `disabled`, with the
-- identical patch the console used to send. The confirmation survives on the click that
-- asks and is refused on the click that does not — which is the whole finding.
do $$
declare
  uid_p uuid; uid_d uuid;
  stamp_p timestamptz; stamp_d timestamptz;
  stamp_c timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Two accounts that are not already on the team, so nothing real is disturbed.
  select u.id into uid_p from auth.users u
   where not exists (select 1 from public.admin_users a where a.user_id = u.id)
   order by u.id limit 1;
  select u.id into uid_d from auth.users u
   where not exists (select 1 from public.admin_users a where a.user_id = u.id)
     and u.id <> uid_p
   order by u.id limit 1;
  if uid_p is null or uid_d is null then
    raise exception 'need two auth.users outside admin_users to stage against';
  end if;

  insert into public.admin_users (user_id, role, status, factors_confirmed_at)
  values (uid_p, 'support', 'pending', null), (uid_d, 'support', 'disabled', null);

  -- THE OLD CONSOLE PATCH, byte for byte in intent: status + a fresh stamp.
  update public.admin_users
     set status = 'active', disabled_at = null, factors_confirmed_at = now()
   where user_id in (uid_p, uid_d);

  select factors_confirmed_at into stamp_p from public.admin_users where user_id = uid_p;
  select factors_confirmed_at into stamp_d from public.admin_users where user_id = uid_d;

  if stamp_p is null then
    raise exception 'FIX TOO BROAD: pending -> active no longer records the confirmation, '
                    'so Activate stopped being the click that vouches';
  end if;
  raise notice 'pending -> active still vouches — that click prints the factor list and asks';

  if stamp_d is not null then
    raise exception 'FIX FAILED: disabled -> active still stamped %, so Restore is still '
                    'vouching for factors nobody was shown', stamp_d;
  end if;
  raise notice 'disabled -> active refused the stamp: restoring returns ACCESS and vouches for nothing';

  -- The state the control keys on. Its first arm is `factors_confirmed_at is null`, so a
  -- restored row is reported as unconfirmed rather than silently certified, and /team's
  -- needsConfirm shows the Confirm authenticators button on the same condition.
  if (select factors_confirmed_at is not null from public.admin_users where user_id = uid_d) then
    raise exception 'restored row is not in the state ctl_admin_unconfirmed_factor reports';
  end if;
  raise notice 'the restored row lands in exactly the state the control and /team both key on';

  -- And the click whose only purpose IS the confirmation still works: status untouched,
  -- stamp written. Without this the fix would have removed the way to close the finding.
  update public.admin_users set factors_confirmed_at = now() where user_id = uid_d;
  select factors_confirmed_at into stamp_c from public.admin_users where user_id = uid_d;
  if stamp_c is null then
    raise exception 'Confirm authenticators can no longer vouch — the finding would never close';
  end if;
  raise notice 'Confirm authenticators still vouches, so the finding stays closable';

  -- Revoking clears it again, so a second revoke/restore round does not inherit a vouch.
  update public.admin_users
     set status = 'disabled', disabled_at = now(), factors_confirmed_at = null
   where user_id = uid_d;
  update public.admin_users set status = 'active', disabled_at = null where user_id = uid_d;
  if (select factors_confirmed_at is not null from public.admin_users where user_id = uid_d) then
    raise exception 'a second restore inherited a stale vouch';
  end if;
  raise notice 'revoke clears and restore does not re-vouch, so the cycle cannot launder a factor';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'restore-never-vouches probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
