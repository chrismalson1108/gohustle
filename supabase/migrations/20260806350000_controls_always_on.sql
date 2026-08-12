-- ─────────────────────────────────────────────────────────────────────────────
-- Controls stay on by themselves, and three gaps today exposed.
--
-- ── WHY DISABLING AUTO-EXPIRES RATHER THAN BEING FORBIDDEN ──────────────────
--
-- ctl_admin_login_bruteforce was switched off during an audit and stayed off for
-- hours. Every sweep afterwards truthfully reported "0 errored, 0 stale", because a
-- disabled control can do neither — it simply is not looking.
--
-- The obvious response is to forbid disabling. That is worse. A control that errors in
-- a loop, or fires on known-bad seed data, needs a mute; take the mute away and the
-- next person drops the trigger, deletes the registry row, or revokes the function —
-- all of which are permanent, none of which are visible.
--
-- So the valve stays, and it closes on its own. A disabled control re-enables after
-- disabled_until (default 24h), enforced by run_all_controls, which every sweep calls.
-- You can silence something at 2am during an incident; you cannot silence it forever by
-- forgetting. ctl_control_disabled still reports it for as long as it lasts.
--
-- ── THE NEW CONTROLS ────────────────────────────────────────────────────────
--
-- Each of these is a failure this codebase actually produced today, generalised:
--
--   dispute_evidence_missing  — a booking cites photos that are no longer in the
--       bucket. Photos are now explicitly described in-app as the record relied on in
--       a dispute; a promise of evidence that has silently evaporated is worse than
--       never having made it.
--
--   stripe_id_mode_mismatch   — a stored Stripe identifier from the wrong mode. Live
--       keys with a test acct_/cus_ id fails at the moment a poster tries to pay, and
--       there are 7 connected accounts and 4 customers holding test ids right now.
--       This is the single most likely way the live cutover breaks.
--
--   legal_doc_self_contradiction — a published document whose own "Last updated" line
--       disagrees with the version it is filed under. Found today: privacy and terms
--       are both version 2026-08-06 and both say "July 2, 2026", because the August
--       bodies were derived from the July ones. A legal document that misstates its own
--       date is a bad thing to hand someone in a dispute.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.controls
  add column if not exists disabled_until timestamptz,
  add column if not exists disabled_reason text;

-- Anything switched off from here on gets an expiry. Existing disabled rows (none
-- today) are given one too, so nothing can be off indefinitely by pre-dating this.
update public.controls
   set disabled_until = coalesce(disabled_until, now() + interval '24 hours')
 where not enabled;

create or replace function public.reenable_expired_controls()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.controls
     set enabled = true,
         disabled_until = null,
         disabled_reason = null
   where not enabled
     and disabled_until is not null
     and disabled_until <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.reenable_expired_controls() from public, anon, authenticated;

-- Stamp an expiry on every disable, whatever route it came in by — the console, a
-- script, or psql. A disable with no expiry is the state this is here to prevent.
create or replace function public.trg_control_disable_expires()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.enabled then
    if old.enabled or new.disabled_until is null then
      new.disabled_until := coalesce(
        nullif(new.disabled_until, old.disabled_until),
        now() + interval '24 hours');
    end if;
  else
    new.disabled_until := null;
    new.disabled_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_z_control_disable_expires on public.controls;
create trigger trg_z_control_disable_expires
  before update of enabled, disabled_until on public.controls
  for each row execute function public.trg_control_disable_expires();

-- Re-enable BEFORE running the sweep. REPRODUCED FROM THE LIVE pg_proc BODY: it
-- returns a TABLE and filters `not external`, neither of which I would have
-- reproduced from memory — an earlier draft here returned integer and was rejected
-- by Postgres only because the return type changed. Retyping a live function is the
-- mistake that has cost the most time on this codebase.
create or replace function public.run_all_controls()
returns TABLE(control_key text, violations integer, errored boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  n integer;
begin
  -- A mute that has lapsed is lifted BEFORE the sweep, so a control whose window
  -- expired reports in this run rather than the next one.
  perform public.reenable_expired_controls();

  for r in select key from public.controls where enabled and not external order by key loop
    begin
      n := public.run_control(r.key);
      control_key := r.key; violations := n; errored := false;
      return next;
    exception when others then
      update public.controls
         set last_run_at = now(), last_error = sqlerrm, last_violations = null
       where key = r.key;
      control_key := r.key; violations := null; errored := true;
      return next;
    end;
  end loop;
end;
$fn$;

revoke execute on function public.run_all_controls() from public, anon, authenticated;

-- ── 1. Dispute evidence that is no longer there ─────────────────────────────
create or replace function public.ctl_dispute_evidence_missing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'booking_status', b.status,
           'claimed_before', coalesce(array_length(b.before_photos, 1), 0),
           'claimed_after', coalesce(array_length(b.completion_photos, 1), 0),
           'found_in_bucket', (
             select count(*) from storage.objects o
              where o.bucket_id = 'completion-photos'
                and o.name = any (coalesce(b.before_photos, '{}') || coalesce(b.completion_photos, '{}'))),
           'note', 'the booking cites proof-of-work photos that are not in the bucket')
    from public.bookings b
   where (coalesce(array_length(b.before_photos, 1), 0)
        + coalesce(array_length(b.completion_photos, 1), 0)) > 0
     and (select count(*) from storage.objects o
           where o.bucket_id = 'completion-photos'
             and o.name = any (coalesce(b.before_photos, '{}') || coalesce(b.completion_photos, '{}')))
         < (coalesce(array_length(b.before_photos, 1), 0)
          + coalesce(array_length(b.completion_photos, 1), 0))
$$;

revoke execute on function public.ctl_dispute_evidence_missing() from public, anon, authenticated;

-- ── 2. A Stripe id from the wrong mode ──────────────────────────────────────
-- Test ids and live ids are distinguishable: Stripe test objects carry a _test_
-- segment on some types, but the reliable signal is that a live-mode key cannot
-- retrieve a test-mode id at all. This checks the cheap structural half — that every
-- stored id at least LOOKS like the mode the platform is configured for — using
-- app_flags.stripe_mode as the declared truth.
create or replace function public.ctl_stripe_id_mode_mismatch()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with mode as (
    select coalesce((select value->>'mode' from public.app_flags where key = 'stripe_mode'), 'test') m
  )
  select a.user_id::text,
         jsonb_build_object(
           'kind', 'connected_account',
           'account_id', a.account_id,
           'declared_mode', (select m from mode),
           'note', 'a Stripe id stored under one mode is meaningless in the other — '
                   'the charge fails at the moment a poster tries to pay')
    from public.stripe_accounts a, mode
   where mode.m = 'live' and a.account_id like 'acct_1%' and length(a.account_id) < 22
  union all
  select c.user_id::text,
         jsonb_build_object('kind', 'customer', 'customer_id', c.customer_id,
                            'declared_mode', (select m from mode),
                            'note', 'stale customer id for the declared Stripe mode')
    from public.stripe_customers c, mode
   where mode.m = 'live' and c.customer_id like 'cus_%' and length(c.customer_id) < 19
$$;

revoke execute on function public.ctl_stripe_id_mode_mismatch() from public, anon, authenticated;

-- ── 3. A legal document that misstates its own date ─────────────────────────
create or replace function public.ctl_legal_doc_self_contradiction()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select d.slug || '@' || d.version,
         jsonb_build_object(
           'version', d.version,
           'body_says', substring(d.body from 'Last updated: [A-Za-z]+ [0-9]+, [0-9]+'),
           'published_at', d.published_at,
           'acceptances', (select count(*) from public.legal_acceptances a
                            where a.slug = d.slug and a.version = d.version),
           'note', 'the document is filed under one date and tells the reader another; '
                   'correcting an ACCEPTED body falsifies what those users agreed to, so '
                   'this is fixed by publishing a new version, not by editing in place')
    from (select distinct on (slug) slug, version, body, published_at
            from public.legal_documents order by slug, published_at desc) d
   where substring(d.body from 'Last updated: [A-Za-z]+ [0-9]+, [0-9]+') is not null
     and to_char(d.version::date, 'FMMonth FMDD, YYYY')
         <> replace(substring(d.body from 'Last updated: ([A-Za-z]+ [0-9]+, [0-9]+)'), '  ', ' ')
$$;

revoke execute on function public.ctl_legal_doc_self_contradiction() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('dispute_evidence_missing',
   'A booking cites proof-of-work photos that are no longer in storage',
   'high', 'integrity',
   'The finish sheet now tells earners these photos are the record relied on if the '
   'work is disputed. A promise of evidence that has silently evaporated is worse than '
   'never having made it — the person who did the work loses the thing they were told '
   'would protect them.',
   'ctl_dispute_evidence_missing'),
  ('stripe_id_mode_mismatch',
   'A stored Stripe identifier does not match the platform''s declared Stripe mode',
   'critical', 'money',
   'Test-mode and live-mode Stripe objects are separate universes. A live key cannot '
   'retrieve a test acct_ or cus_ id, so the failure lands at the exact moment a poster '
   'tries to pay. There are connected accounts and customers holding test ids today, '
   'which makes this the most likely way the live cutover breaks.',
   'ctl_stripe_id_mode_mismatch'),
  ('legal_doc_self_contradiction',
   'A published legal document''s own date disagrees with the version it is filed under',
   'medium', 'integrity',
   'Privacy and Terms are both version 2026-08-06 and both read "Last updated: July 2, '
   '2026", because the August bodies were derived from the July ones and only the '
   'changed paragraph was rewritten. A document that misstates its own effective date '
   'is a bad thing to rely on in a dispute.',
   'ctl_legal_doc_self_contradiction')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
