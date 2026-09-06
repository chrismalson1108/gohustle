-- ─────────────────────────────────────────────────────────────────────────────
-- The web alerts badge and the alerts inbox subscribe to a table Postgres never
-- publishes, so neither channel can ever deliver an event.
--
-- Supabase's `postgres_changes` only emits rows for tables that are MEMBERS of the
-- `supabase_realtime` publication. Across the whole repo that publication is defined
-- by exactly two statements, both in the legacy files:
--
--   supabase/migration_fix_lifecycle.sql:145-147
--     DROP PUBLICATION IF EXISTS supabase_realtime;
--     CREATE PUBLICATION supabase_realtime FOR TABLE public.bookings, public.jobs,
--                                                    public.messages;
--   supabase/migration_stripe.sql:73
--     alter publication supabase_realtime add table public.payments;
--
-- `public.notifications` (created in supabase/migration_competitive_features.sql:49) is
-- never added — and two live subscriptions depend on it:
--
--   web/lib/notifications.ts       useUnreadNotifications() → channel "notifications-badge"
--                                  drives the nav alerts badge (web/components/AppShell.tsx)
--   web/app/(app)/notifications/page.tsx  channel "notifications-page" → reloads the inbox
--
-- So from the tracked schema those two channels open a realtime connection each and
-- deliver nothing. An earner applies, send-push writes a notifications row, and the
-- poster's badge stays where it was: it only moves when AppShell re-runs refreshAlerts()
-- on the next navigation — the workaround whose own comment says "the realtime channels
-- can miss updates". The inbox does not move until a reload.
--
-- If production is currently delivering these events, the table was enabled from the
-- Supabase dashboard out of band. CLAUDE.md forbids hand-applying schema there precisely
-- because of this: the tracked SQL and the live database then disagree, and a rebuild
-- from the tracked files silently drops the membership. Either way the tracked schema is
-- wrong, and the fix is the same. The add below is idempotent, so it is a no-op on a
-- database where the toggle was already flipped.
--
-- ── WHY PUBLISHING THIS TABLE IS SAFE ───────────────────────────────────────
-- A publication feeds realtime, and realtime re-applies the table's own SELECT policy
-- per subscriber. `notifications` has RLS enabled with an owner-scoped select policy
-- (migration_competitive_features.sql:60-64) and anon's read revoked
-- (20260725010000_revoke_anon_public_read_3.sql), so each user receives only their own
-- alerts. That is a precondition, not a hope — publishing a table whose RLS was off
-- would broadcast every user's alerts to every subscriber, so the assertion block below
-- checks it rather than assuming it.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Deliberately fatal rather than creating it here. A publication created at this
    -- point would contain notifications and NOTHING ELSE, which silently unpublishes
    -- bookings, jobs, messages and payments — every other live update in both clients.
    raise exception 'supabase_realtime does not exist. It is created by the legacy file '
                    'supabase/migration_fix_lifecycle.sql (bookings, jobs, messages) and '
                    'extended by supabase/migration_stripe.sql (payments); both are applied '
                    'before supabase/migrations/. Apply those first.';
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
    raise notice 'added public.notifications to supabase_realtime';
  else
    raise notice 'public.notifications was already published (dashboard toggle); now tracked in SQL';
  end if;
end $$;

-- ── Assert the fix, and that the check measuring it is not vacuous ───────────
do $$
declare
  present boolean;
  rls_on  boolean;
  owns    boolean;
begin
  select exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) into present;
  if not present then
    raise exception 'FIX FAILED: public.notifications is still not a member of supabase_realtime';
  end if;
  raise notice 'public.notifications is published, so postgres_changes can reach the badge and the inbox';

  -- Not vacuous: the same query reports a table nobody publishes as absent. `profiles`
  -- has no subscriber and is deliberately not in the publication.
  select exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) into present;
  if present then
    raise exception 'public.profiles is published — either the membership check is meaningless '
                    'here or something published a table with no subscriber';
  end if;
  raise notice 'discriminates: the same check reports unpublished public.profiles as absent';

  -- The precondition that makes publishing this table safe.
  select relrowsecurity into rls_on from pg_class
   where oid = 'public.notifications'::regclass;
  if not coalesce(rls_on, false) then
    raise exception 'REFUSING the state this migration just created: notifications is published '
                    'to realtime with RLS OFF, which broadcasts every user''s alerts to every '
                    'subscriber';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notifications' and cmd = 'SELECT'
  ) then
    raise exception 'notifications has RLS on but no SELECT policy — realtime would deliver nothing '
                    'and the subscription would still look alive';
  end if;
  raise notice 'RLS is on with a SELECT policy, so each subscriber receives only their own alerts';

  -- A rolled-back probe that stages the BROKEN state and shows the assertion above fires
  -- on it. Skipped when this role does not own the publication, because the drop would
  -- fail on privileges rather than on the thing being measured.
  select pg_has_role(current_user, (select pubowner from pg_publication where pubname = 'supabase_realtime'), 'MEMBER')
    into owns;
  if not owns then
    raise notice 'skipping the discrimination probe: this role does not own supabase_realtime';
    return;
  end if;

  begin
    alter publication supabase_realtime drop table public.notifications;
    select exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) into present;
    if present then
      raise exception 'the membership check cannot see a removal, so it was never measuring the publication';
    end if;
    raise notice 'discriminates: with notifications dropped the check reports it missing — which is the state the app shipped in';
    raise exception 'probe complete — rolling back';
  exception when others then
    if sqlerrm = 'probe complete — rolling back' then
      raise notice 'publication probe passed; the drop was rolled back';
    else
      raise;
    end if;
  end;

  -- And it is back.
  select exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) into present;
  if not present then
    raise exception 'the probe did not roll back: notifications is no longer published';
  end if;
  raise notice 'notifications is published after the probe rolled back';
end $$;
