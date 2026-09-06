-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing watched the suspension that stops a harasser reaching the person who
-- reported them (2026-09-06).
--
-- Suspension is the platform's safety kill switch. It is used when someone is believed
-- to be a risk to another user, and because every channel here is party-scoped, the
-- people a suspended account can still reach are precisely its existing booking
-- counterparties — "the person who most likely just reported them"
-- (20260730150000:19-25). Three write paths are what make the suspension real, and each
-- is a single clause:
--
--   messages   messages_insert              `and not private.is_suspended(auth.uid())`
--              (20260730150000:49, re-stated 20260906041000:136)
--   bookings   guard_booking_not_suspended  (20260726070000:70-97) — both directions
--   reviews    reviews_insert_auth          `and not private.is_suspended(auth.uid())`
--              (20260906055000:95), the write RUNBOOK_SAFETY §2.3 records as permanent
--
-- NOTHING asserted the outcome against data:
--     grep -rn 'is_suspended' supabase/migrations/*.sql | grep -i ctl_   ->  nothing
-- The 69-row registry had no suspension check of any kind. So a message, booking or
-- review written by an account AFTER its suspended_at is a row that is supposed to be
-- impossible, and no control would report it.
--
-- ── THE REGRESSION IS NAMED IN CLAUDE.md, WITH A ROUTE TO IT ────────────────
-- CLAUDE.md's Supabase section warns that re-running the legacy
-- migration_fix_lifecycle.sql recreates messages_insert with only the block check, "so
-- re-running it re-opens messaging for suspended accounts", and closes with the sentence
-- this file exists for: "Neither failure errors; the policy just gets weaker." A session
-- following an old instruction, a scripted regeneration from the wrong source
-- definition, or a policy rewritten from scratch instead of extended all land in the
-- same place: the clause is gone, every test still passes, and the first person to
-- notice is the victim.
--
-- The suspended account does not even need a new session to use it. The admin action's
-- own success text says an in-flight token lives "up to ~1h", and 20260906055000 records
-- that a block has no window at all.
--
-- This repo already answers exactly this class of risk with a canary control — for a
-- policy (ctl_support_intake_writable), for a grant (ctl_client_holds_truncate), for a
-- trigger (ctl_booking_status_contradicts_done_flags), and most recently for the address
-- masker (ctl_job_location_unmasked, 20260906052000). This is that shape, for the guard
-- CLAUDE.md itself says gets silently weakened.
--
-- ── WHY THE INVARIANT IS SAFE TO ASSERT AGAINST DATA ────────────────────────
-- All three checks are DB predicates evaluated AT WRITE TIME against
-- profiles.suspended_at. So while they hold, a row of any of these three kinds whose
-- created_at is after its author's suspended_at cannot be produced by a client at all —
-- the probe below shows the write refused with 42501 and the identical write landing a
-- moment earlier. The canary therefore has no false-positive population: it is empty
-- while the clauses exist and fills the moment one is lost.
--
-- Rows written BEFORE the suspension are the ordinary state of every suspended account
-- and stay silent, which is what stops this control from filing findings on the entire
-- history of everyone ever suspended. Unsuspend clears suspended_at, and a re-suspension
-- stamps a LATER one, so anything sent legitimately in between stays behind the cutoff.
--
-- ── THE GRACE WINDOW IS 60 SECONDS, NOT AN HOUR ────────────────────────────
-- The obvious grace to reach for is the ~1h in-flight token. That would be the wrong
-- one, and it would blind the canary for exactly the hour the suspension exists to
-- cover: none of the three checks consults the token, they consult the row.
--
-- What does need absorbing is smaller and real. suspendUser stamps suspended_at from the
-- CONSOLE's clock — `new Date().toISOString()` in
-- admin/app/(console)/users/[id]/actions.ts:145 — while created_at comes from the
-- database's, so a legitimate write moments before a suspension can carry a timestamp
-- marginally after it under ordinary NTP skew. Commit ordering does the same: a write
-- whose snapshot predates the suspending transaction commits after it. 60 seconds covers
-- both and leaves the hour that matters fully reported.
--
-- ── WHAT IS DELIBERATELY NOT AN ARM ────────────────────────────────────────
-- JOBS. A suspended poster's listings are HIDDEN (jobs_select_all, 20260726070000:62-67)
-- but there is no insert guard: jobs_insert_auth (schema.sql:134) checks only
-- poster_id = auth.uid(), and no trigger on jobs tests is_suspended. A jobs arm would
-- therefore report rows the schema currently permits — a control with a standing
-- false-positive population, which is how a control gets muted and then deleted. That
-- gap is a product decision (the gig is invisible the moment it exists), not a lost
-- guard, so it is not a canary's business.
--
-- The COUNTERPARTY is never the subject. All three checks are one-sided on purpose —
-- stopping the other person from writing to a just-suspended account would punish the
-- wrong person (20260730150000:26-29) — so a message TO a suspended user is healthy and
-- is not reported.
--
-- The finding carries ids and timings, never content. A control that quoted the
-- harassing message would copy it into a second table in order to report it; the row id
-- is enough to read it where it already is.
--
-- `union all` across three tables is safe here where 20260906052000 avoided it: each arm
-- emits at most one row per row of its own table and the ids live in separate namespaces
-- ('msg:' / 'booking:' / 'review:'), the discipline ctl_stripe_id_mode_mismatch uses.
-- The booking arm folds both parties into ONE row rather than a row per suspended side,
-- or a booking between two suspended accounts would name the same entity twice.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_suspended_user_active()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with suspended as (
    -- One cutoff column, so the grace window has a single definition to change.
    select p.id,
           p.suspended_at,
           p.suspended_at + interval '60 seconds' as cutoff
      from public.profiles p
     where p.suspended_at is not null
  )
  -- 1. MESSAGES — the channel 20260730150000 closed, and the one CLAUDE.md says a
  --    legacy re-run re-opens.
  select 'msg:' || m.id::text,
         jsonb_build_object(
           'kind', 'message',
           'suspended_user', s.id,
           'suspended_at', s.suspended_at,
           'created_at', m.created_at,
           'minutes_after', round(extract(epoch from m.created_at - s.suspended_at) / 60)::int,
           'booking_id', m.booking_id,
           -- WHO WAS REACHED. On a suspension that followed a report this is usually the
           -- reporter, which is the whole reason the clause exists.
           'reached_user', case when m.sender_id = b.earner_id then j.poster_id else b.earner_id end,
           -- The message text is deliberately NOT copied here.
           'enforced_by', 'messages_insert: and not private.is_suspended(auth.uid())',
           'note', 'This message was sent by an account that was already suspended. '
                   'messages_insert refuses that write, so this row means the clause was '
                   'not in force when it was written.',
           'remedy', 'Treat as live contact with a person the platform decided this '
                     'account must not reach. 1) Confirm the policy: select '
                     'pg_get_expr(polwithcheck, polrelid) from pg_policy where polname = '
                     '''messages_insert''; it must contain private.is_suspended. If it '
                     'does not, something recreated it from an older definition — '
                     'migration_fix_lifecycle.sql is the known route — and it is re-open '
                     'for every suspended account, not just this one. Restore it with a '
                     'migration, never by hand. 2) Page safety per RUNBOOK_SAFETY and '
                     'tell the person who was reached. 3) Leave the rows alone: they are '
                     'the evidence, and deleting them destroys the counterparty''s copy.'
         )
    from public.messages m
    join suspended s on s.id = m.sender_id
    -- LEFT, so a violation is never hidden by a row that failed to join.
    left join public.bookings b on b.id = m.booking_id
    left join public.jobs j on j.id = b.job_id
   where m.created_at > s.cutoff

  union all

  -- 2. BOOKINGS — guard_booking_not_suspended checks BOTH parties. One row per booking
  --    whichever side (or both) is suspended.
  select 'booking:' || b.id::text,
         jsonb_build_object(
           'kind', 'booking',
           'parties', (case when f.e_bad then array['earner'] else array[]::text[] end)
                      || (case when f.p_bad then array['poster'] else array[]::text[] end),
           -- The earliest OFFENDING suspension, not merely the earliest one: a poster
           -- suspended long after this booking must not supply its timestamp.
           'suspended_user', case when f.e_bad and (not f.p_bad or se.suspended_at <= sp.suspended_at)
                                  then b.earner_id else j.poster_id end,
           'suspended_at', least(case when f.e_bad then se.suspended_at end,
                                 case when f.p_bad then sp.suspended_at end),
           'created_at', b.created_at,
           'minutes_after', round(extract(epoch from b.created_at
                                          - least(case when f.e_bad then se.suspended_at end,
                                                  case when f.p_bad then sp.suspended_at end)) / 60)::int,
           'earner_id', b.earner_id,
           'poster_id', j.poster_id,
           'job_id', b.job_id,
           'booking_status', b.status,
           'enforced_by', 'guard_booking_not_suspended (before insert on bookings)',
           'note', 'This booking was created after a party was suspended. The guard '
                   'refuses that insert in both directions, so the trigger was absent, '
                   'disabled, or the write arrived as service_role.',
           'remedy', 'A booking with a suspended party has a counterparty who cannot sign '
                     'in to perform, confirm or settle it, and on a safety suspension it '
                     'is a fresh in-person match with someone the platform removed. '
                     '1) Confirm the trigger: select tgname, tgenabled from pg_trigger '
                     'where tgrelid = ''public.bookings''::regclass and tgname = '
                     '''trg_guard_booking_not_suspended''; tgenabled must be ''O''. '
                     'Restore or re-enable it with a migration. 2) Cancel the booking '
                     'through the normal path so the escrow hold is released — never by '
                     'updating the row. 3) Page safety per RUNBOOK_SAFETY.'
         )
    from public.bookings b
    left join public.jobs j on j.id = b.job_id
    left join suspended se on se.id = b.earner_id
    left join suspended sp on sp.id = j.poster_id
    cross join lateral (
      select (se.id is not null and b.created_at > se.cutoff) as e_bad,
             (sp.id is not null and b.created_at > sp.cutoff) as p_bad
    ) f
   where f.e_bad or f.p_bad

  union all

  -- 3. REVIEWS — the write that lands on a PUBLIC profile and, per RUNBOOK_SAFETY §2.3,
  --    cannot be redacted afterwards.
  select 'review:' || r.id::text,
         jsonb_build_object(
           'kind', 'review',
           'suspended_user', s.id,
           'suspended_at', s.suspended_at,
           'created_at', r.created_at,
           'minutes_after', round(extract(epoch from r.created_at - s.suspended_at) / 60)::int,
           'reviewed_user', r.reviewed_user_id,
           'job_id', r.job_id,
           'review_role', r.role,
           -- The review text is deliberately NOT copied here.
           'enforced_by', 'reviews_insert_auth: and not private.is_suspended(auth.uid())',
           'note', 'This review was published by an account that was already suspended. '
                   'reviews_insert_auth refuses that write, so the clause was not in force '
                   'when it was written.',
           'remedy', 'A review is permanent and public: RUNBOOK_SAFETY §2.3 records that '
                     'there is no way to redact one. 1) Confirm the policy: select '
                     'pg_get_expr(polwithcheck, polrelid) from pg_policy where polname = '
                     '''reviews_insert_auth''; it must contain private.is_suspended. '
                     'Restore it with a migration if not. 2) Decide with trust whether the '
                     'review stands; removing it also means recomputing the subject''s '
                     'rating via recompute_ratings.'
         )
    from public.reviews r
    join suspended s on s.id = r.reviewer_id
   where r.created_at > s.cutoff
$$;

revoke execute on function public.ctl_suspended_user_active() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('suspended_user_active',
   'A suspended account wrote after its suspension',
   'high', 'security',
   'Suspension is the safety kill switch, and every channel it closes is party-scoped — '
   'so the people a suspended account can still reach are its existing booking '
   'counterparties, i.e. whoever most likely just reported them. Three one-line clauses '
   'are the whole enforcement: messages_insert and reviews_insert_auth carry '
   'not private.is_suspended(auth.uid()), and guard_booking_not_suspended covers both '
   'parties on a booking insert. CLAUDE.md records that re-running the legacy '
   'migration_fix_lifecycle.sql recreates messages_insert without its clause, and that '
   '"neither failure errors; the policy just gets weaker". Nothing asserted the outcome '
   'against data. All three are write-time predicates, so a row created after its '
   'author''s suspended_at is impossible while they hold — an empty control that fills '
   'only when one is lost. 60s of grace covers the console clock stamping suspended_at '
   'and commit ordering; the ~1h in-flight token is deliberately NOT excused, because '
   'none of the three checks consults the token.',
   'ctl_suspended_user_active')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove the canary fires on the regression, stays silent on every healthy shape, and
-- ── that the mechanism it watches is still refusing the write today ─────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; mid uuid; rid uuid;
  n int; d jsonb; msg_at timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A KNOWN minor is hard-blocked from messaging and booking by trg_min_age_* whatever
  -- their suspension state, and a blocked pair is refused by a different clause of the
  -- same policy — either would make step 5 pass for the wrong reason.
  select p.id into poster from public.profiles p
   where p.deleted_at is null and p.suspended_at is null
     and (p.date_of_birth is null or p.date_of_birth <= current_date - interval '18 years')
   limit 1;
  select p.id into earner from public.profiles p
   where p.deleted_at is null and p.suspended_at is null and p.id <> poster
     and (p.date_of_birth is null or p.date_of_birth <= current_date - interval '18 years')
     and not exists (select 1 from public.blocks bl
                      where (bl.blocker_id = p.id and bl.blocked_id = poster)
                         or (bl.blocker_id = poster and bl.blocked_id = p.id))
   limit 1;
  if poster is null or earner is null then
    raise exception 'need two live, unblocked, non-minor profiles to stage against';
  end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (poster, 'suspension canary probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'verified')
  returning id into bid;
  insert into public.messages (booking_id, sender_id, text)
  values (bid, earner, 'probe: an ordinary message')
  returning id, created_at into mid, msg_at;
  insert into public.reviews (job_id, reviewer_id, reviewed_user_id, author, role, rating, text, date)
  values (jid, earner, poster, 'Earner', 'poster', 5, 'probe review', 'probe')
  returning id into rid;

  -- 1. Nobody suspended: silent. If this ever fires, the control is noise on live data.
  select count(*) into n from public.ctl_suspended_user_active()
   where entity_id in ('msg:' || mid::text, 'booking:' || bid::text, 'review:' || rid::text);
  if n <> 0 then
    raise exception 'fired on rows written by an unsuspended account — permanent noise (% rows)', n;
  end if;
  raise notice 'silent on an unsuspended account, so the canary has no baseline population';

  -- 2. Suspended NOW, with all three rows written before it. That is the ordinary state
  --    of every suspension ever performed; reporting it would file findings on the whole
  --    history of every suspended account and the control would be muted within a week.
  -- clock_timestamp(), not now(): now() is the TRANSACTION's timestamp and every row
  -- staged above carries it as created_at, so the suspension would land on the same
  -- instant and this step would pass without ever testing "before".
  update public.profiles set suspended_at = clock_timestamp() where id = earner;
  if not private.is_suspended(earner) then
    raise exception 'staging failed: suspended_at did not stick, so nothing below proves anything';
  end if;
  if (select suspended_at from public.profiles where id = earner) <= msg_at then
    raise exception 'staging failed: the suspension is not strictly after the staged rows';
  end if;
  select count(*) into n from public.ctl_suspended_user_active()
   where entity_id in ('msg:' || mid::text, 'booking:' || bid::text, 'review:' || rid::text);
  if n <> 0 then
    raise exception 'reports history written BEFORE the suspension — every suspension would file findings (% rows)', n;
  end if;
  raise notice 'silent on rows that predate the suspension, which is every suspension''s normal state';

  -- 3. THE REGRESSION. Exactly the shape a lost clause produces: the same three rows now
  --    sit after their author's suspended_at.
  update public.profiles set suspended_at = now() - interval '1 day' where id = earner;

  select count(*) into n from public.ctl_suspended_user_active() where entity_id = 'msg:' || mid::text;
  if n <> 1 then raise exception 'FIX FAILED: a message sent after suspension reported % rows', n; end if;
  select detail into d from public.ctl_suspended_user_active() where entity_id = 'msg:' || mid::text;
  if d ->> 'kind' <> 'message' or (d ->> 'suspended_user') <> earner::text then
    raise exception 'the message finding names the wrong actor (%)', d;
  end if;
  if (d ->> 'reached_user') <> poster::text then
    raise exception 'the finding does not name the person who was reached (%)', d ->> 'reached_user';
  end if;
  if d::text like '%probe: an ordinary message%' then
    raise exception 'the finding copied the message content into control_findings';
  end if;

  select count(*) into n from public.ctl_suspended_user_active() where entity_id = 'booking:' || bid::text;
  if n <> 1 then raise exception 'FIX FAILED: a booking created after suspension reported % rows', n; end if;
  select detail into d from public.ctl_suspended_user_active() where entity_id = 'booking:' || bid::text;
  if not ((d -> 'parties') ? 'earner') or (d -> 'parties') ? 'poster' then
    raise exception 'the booking finding names the wrong side(s): %', d -> 'parties';
  end if;

  select count(*) into n from public.ctl_suspended_user_active() where entity_id = 'review:' || rid::text;
  if n <> 1 then raise exception 'FIX FAILED: a review published after suspension reported % rows', n; end if;
  select detail into d from public.ctl_suspended_user_active() where entity_id = 'review:' || rid::text;
  if d::text like '%probe review%' then
    raise exception 'the finding copied the review text into control_findings';
  end if;

  raise notice 'discriminates: the same three rows are silent before the suspension and reported after it';

  -- 4. The grace window. It exists for the console clock that stamps suspended_at and for
  --    commit ordering — NOT for the ~1h in-flight token, which none of the three checks
  --    consults. So a few seconds of skew is absorbed and ninety seconds is reported.
  update public.profiles set suspended_at = msg_at - interval '10 seconds' where id = earner;
  select count(*) into n from public.ctl_suspended_user_active() where entity_id = 'msg:' || mid::text;
  if n <> 0 then
    raise exception 'no grace at all: ordinary clock skew between the console and the database would file findings';
  end if;
  update public.profiles set suspended_at = msg_at - interval '90 seconds' where id = earner;
  select count(*) into n from public.ctl_suspended_user_active() where entity_id = 'msg:' || mid::text;
  if n <> 1 then
    raise exception 'the grace window is far too wide — 90 seconds after a suspension went unreported, so the hour that matters would too';
  end if;
  raise notice 'ten seconds of skew is absorbed and ninety seconds is reported: the hour the suspension covers is not excused';

  -- 5. The mechanism the canary watches is still refusing the write TODAY, so the
  --    control's population is empty by construction rather than by luck. Run as the
  --    suspended user over RLS: as the owner the policy does not apply and this would
  --    prove nothing. The claims are flipped back to service_role for each profile write
  --    because guard_profiles_write pins suspended_at for everyone else.
  update public.profiles set suspended_at = null where id = earner;
  perform set_config('request.jwt.claims',
    json_build_object('sub', earner::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.messages (booking_id, sender_id, text)
  values (bid, earner, 'probe: message while not suspended');
  perform set_config('role', 'postgres', true);
  raise notice 'clean: the same insert lands while the account is not suspended';

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.profiles set suspended_at = now() where id = earner;
  perform set_config('request.jwt.claims',
    json_build_object('sub', earner::text, 'role', 'authenticated')::text, true);
  begin
    perform set_config('role', 'authenticated', true);
    insert into public.messages (booking_id, sender_id, text)
    values (bid, earner, 'probe: message while suspended');
    perform set_config('role', 'postgres', true);
    raise exception 'messages_insert let a suspended sender write — the regression this canary watches for is ALREADY live';
  exception
    when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      raise notice 'a suspended sender is still refused by messages_insert (42501), so the canary is empty by construction and not by luck';
    when others then
      perform set_config('role', 'postgres', true);
      raise;
  end;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if not exists (select 1 from public.controls
                  where key = 'suspended_user_active' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  -- The handler can be entered while the role is still `authenticated`, which cannot set
  -- it back; swallow that so the real error is what surfaces.
  begin
    perform set_config('role', 'postgres', true);
  exception when others then null;
  end;
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'suspension canary probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
