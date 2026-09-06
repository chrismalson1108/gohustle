-- ─────────────────────────────────────────────────────────────────────────────
-- Two fixes redefined ctl_safety_checkin_overdue, and the later one won.
--
-- Both were correct on their own and they were written against the same base, so
-- neither could see the other:
--
--   · 20260905002200 built the check-in NUDGE that had never existed (nudged_at had
--     no writer anywhere), and narrowed the control so a page means "we asked the
--     worker and got nothing back" — with a 3-hour backstop so a broken nudge stage
--     cannot turn the control silent.
--   · 20260905003100 put the EXACT ADDRESS in the detail, because an on-call opening
--     a page for an overdue worker was handed the masked city and nothing else.
--
-- `create or replace` keeps only the last definition in timestamp order, so merging
-- them applied 003100 last and the nudge predicate disappeared: the control went back
-- to paging the moment due_at passed, on a worker nobody had asked. That is the
-- regression `__tests__/controlRedefinitionCoverage.test.js` and the repo's own
-- "last definition wins" rule exist to catch, and it caught this one.
--
-- This is the union. Nothing new is invented here: the predicate is 002200's, the
-- detail is 003100's plus 002200's stage/escalation keys, and the probe re-proves
-- both properties against one body.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_safety_checkin_overdue()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.booking_id::text,
         jsonb_build_object(
           'earner_id', b.earner_id,
           'poster_id', j.poster_id,
           'job_title', j.title,
           -- The published, masked label. Kept so the pair reads as a pair.
           'location', j.location,
           -- The address itself. jobs.location is masked at write; this is the only
           -- place the precise label exists, and a safety escalation is the case the
           -- product has already decided justifies reading it.
           'exact_location', coalesce(jl.exact_location, j.location),
           'exact_location_known', jl.exact_location is not null,
           'started_at', b.started_at,
           'due_at', c.due_at,
           'hours_overdue', round(extract(epoch from now() - c.due_at) / 3600.0, 1),
           'nudged', c.nudged_at is not null,
           'nudged_at', c.nudged_at,
           'escalated_at', c.escalated_at,
           -- Says which of the two doors this row came through, so an on-call reading
           -- the finding knows whether the worker was ever actually asked.
           'stage', case when c.escalated_at is not null then 'nudge_unanswered'
                         else 'no_nudge_was_sent' end,
           'booking_status', b.status)
    from public.safety_checkins c
    join public.bookings b on b.id = c.booking_id
    join public.jobs j     on j.id = b.job_id
    -- LEFT: a gig posted at city granularity never captured an exact label, and a
    -- missing address must not remove the whole finding from the board.
    left join public.job_locations jl on jl.job_id = j.id
   where c.resolved_at is null
     and c.due_at < now()
     and b.status not in ('completed', 'verified', 'cancelled', 'declined')
     -- The earner said they were done. Waiting on the POSTER is not a safety event.
     and not coalesce(b.earner_done, false)
     and (
       -- An unanswered nudge: the person was asked and did not act.
       c.escalated_at is not null
       -- BACKSTOP. If the nudge stage stops running, this control must not go quiet —
       -- silence on a safety board is indistinguishable from safety.
       or c.due_at < now() - interval '3 hours'
     )
$$;

revoke execute on function public.ctl_safety_checkin_overdue() from public, anon, authenticated;


-- ── Prove BOTH properties hold on the one surviving body ───────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; d jsonb;
  stored_masked text; stored_exact text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'checkin union probe', 'Odd Jobs', 100, 'flat',
          '742 Evergreen Terrace, Springfield, IL', 'probe', 'open')
  returning id into jid;

  select location into stored_masked from public.jobs where id = jid;
  select exact_location into stored_exact from public.job_locations where job_id = jid;
  if stored_exact is null or stored_masked = stored_exact then
    raise exception 'staging failed: no masked/exact pair to discriminate on';
  end if;

  insert into public.bookings (job_id, earner_id, status, started_at)
  values (jid, uid, 'confirmed', now() - interval '6 hours')
  returning id into bid;

  -- ── PROPERTY 1 (from 002200): freshly overdue and un-nudged does NOT page ──
  insert into public.safety_checkins (booking_id, due_at)
  values (bid, now() - interval '20 minutes')
  on conflict (booking_id) do update
    set due_at = excluded.due_at, resolved_at = null, nudged_at = null, escalated_at = null;

  if exists (select 1 from public.ctl_safety_checkin_overdue() where entity_id = bid::text) then
    raise exception 'REGRESSION: a freshly-overdue gig pages before anyone asked the worker';
  end if;
  raise notice 'the nudge predicate survived: a forgotten tap does not page on its own';

  -- ── PROPERTY 1b: an unanswered nudge DOES page, and says so ────────────────
  update public.safety_checkins
     set nudged_at = now() - interval '40 minutes', escalated_at = now()
   where booking_id = bid;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'FIX FAILED: an unanswered nudge pages nobody';
  end if;
  if d->>'stage' <> 'nudge_unanswered' then
    raise exception 'the finding does not say the worker was asked (stage=%)', d->>'stage';
  end if;

  -- ── PROPERTY 2 (from 003100): the detail carries the exact address ────────
  if not (d ? 'exact_location') then
    raise exception 'FIX FAILED: the detail carries no exact_location key';
  end if;
  if d->>'exact_location' is distinct from stored_exact then
    raise exception 'FIX FAILED: exact_location is %, expected %', d->>'exact_location', stored_exact;
  end if;
  if (d->>'exact_location_known')::boolean is not true then
    raise exception 'FIX FAILED: a captured address reported exact_location_known=false';
  end if;
  if d->>'location' is distinct from stored_masked then
    raise exception 'the masked label was dropped from the detail (%)', d->>'location';
  end if;
  raise notice 'the address survived too: location=%, exact_location=%', d->>'location', d->>'exact_location';

  -- ── PROPERTY 1c: the backstop still pages when the nudge stage never ran ──
  update public.safety_checkins
     set nudged_at = null, escalated_at = null, due_at = now() - interval '5 hours'
   where booking_id = bid;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'FIX FAILED: a 5-hour overdue worker is invisible when the nudge stage is not running';
  end if;
  if d->>'stage' <> 'no_nudge_was_sent' then
    raise exception 'the backstop finding does not admit that no nudge was sent (stage=%)', d->>'stage';
  end if;
  raise notice 'the backstop pages when the nudge never ran, and says so';

  -- ── PROPERTY 2b: a city-only gig still reports, flagged unknown ───────────
  delete from public.job_locations where job_id = jid;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'a gig with no captured address dropped off the board entirely';
  end if;
  if (d->>'exact_location_known')::boolean is not false then
    raise exception 'reported exact_location_known=true with no job_locations row';
  end if;
  raise notice 'the LEFT join is still load-bearing';

  -- ── And the earner_done exclusion from 20260806230000 is untouched ────────
  update public.bookings set earner_done = true where id = bid;
  if exists (select 1 from public.ctl_safety_checkin_overdue() where entity_id = bid::text) then
    raise exception 'REGRESSION: fired for an earner who already marked themselves done';
  end if;
  raise notice 'the earner_done exclusion survived the union';

  if not exists (select 1 from public.controls
                  where key = 'safety_checkin_overdue' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'union probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
