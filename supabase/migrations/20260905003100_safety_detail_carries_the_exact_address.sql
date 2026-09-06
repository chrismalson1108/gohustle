-- ─────────────────────────────────────────────────────────────────────────────
-- The overdue-check-in page told the on-call the CITY the worker is missing in.
--
-- ctl_safety_checkin_overdue builds its detail from `j.location`. That column is
-- MASKED at write by trg_mask_job_location (20260722040000): "742 Evergreen Terrace,
-- Springfield, IL" is stored as "Springfield, IL", and the exact label lives in
-- public.job_locations behind job_locations_party_read. So the one detail an escalating
-- safety check-in exists to deliver — where the person actually is — was the one it
-- could not say. The same hole ran through the whole safety path: safety-alert emailed
-- names, ids and a /moderation link with no address at all, `grep -rn job_locations
-- admin/` returned nothing, and RUNBOOK_SAFETY §1 walked the on-call through three
-- console pages, none of which reached an address.
--
-- That is not a masking bug. The masking is correct and stays: it protects the poster
-- from every signed-in stranger. What was missing is that the SAFETY path never used
-- the service-role read it already has. The design has always accepted that an
-- emergency justifies the exact address — gig_shares hands it to whoever the earner
-- gives a token to, on the argument that a masked location helps nobody at 11pm. The
-- people paged to help had less than the earner's friend.
--
-- This control is already SECURITY DEFINER, and job_locations grants all to
-- service_role, so the join needs no new privilege. `location` (masked) is KEPT
-- alongside `exact_location`: an operator reading the finding should be able to see
-- that the two differ, which is what tells them the address is real rather than a
-- gig posted at city granularity.
--
-- ── Where this detail travels, and the one place it is redacted ─────────────
-- control_findings.detail reaches /controls, the daily digest email to the on-call,
-- and — in digest mode only — the Claude triage payload in controls-alert. The first
-- two are the on-call, who is exactly the audience. The third is a third party doing
-- PRIORITISATION, which needs no street address, so controls-alert strips
-- exact_location from the triage payload in the same change. Widening the detail
-- without that would have quietly begun shipping home addresses to an LLM.
--
-- Only the detail changes. The predicate below (including the earner_done exclusion
-- that 20260806230000 added to stop false pages) is carried over verbatim.
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
$$;

revoke execute on function public.ctl_safety_checkin_overdue() from public, anon, authenticated;


-- ── Prove the detail now carries what the old one could not ─────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid;
  d jsonb;
  stored_masked text; stored_exact text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- A gig at a real street address. trg_mask_job_location masks the column on write
  -- and moves the precise label into job_locations — the whole reason this finding
  -- exists.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'overdue address probe', 'Odd Jobs', 100, 'flat',
          '742 Evergreen Terrace, Springfield, IL', 'probe', 'open')
  returning id into jid;

  select location into stored_masked from public.jobs where id = jid;
  select exact_location into stored_exact from public.job_locations where job_id = jid;

  if stored_exact is null then
    raise exception 'staging failed: trg_mask_job_location captured no exact address';
  end if;
  if stored_masked = stored_exact then
    raise exception 'staging failed: jobs.location was not masked, so there is nothing to discriminate';
  end if;
  raise notice 'staged: jobs.location is %, the exact label is %', stored_masked, stored_exact;

  insert into public.bookings (job_id, earner_id, status, started_at)
  values (jid, uid, 'confirmed', now() - interval '6 hours')
  returning id into bid;

  -- An overdue, un-nudged, unresolved check-in: the escalation case.
  insert into public.safety_checkins (booking_id, due_at)
  values (bid, now() - interval '2 hours')
  on conflict (booking_id) do update set due_at = excluded.due_at, resolved_at = null;

  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'the control did not report an overdue check-in at all';
  end if;

  -- THE OLD SHAPE, still present. An operator can see the masked and exact labels
  -- disagree, which is what says the address is real.
  if d->>'location' is distinct from stored_masked then
    raise exception 'the masked label was dropped from the detail (%)', d->>'location';
  end if;

  -- THE FIX. Before this migration the detail contained no such key, so the page an
  -- on-call reads named a city and nothing else.
  if not (d ? 'exact_location') then
    raise exception 'FIX FAILED: the detail carries no exact_location key';
  end if;
  if d->>'exact_location' is distinct from stored_exact then
    raise exception 'FIX FAILED: exact_location is %, expected %', d->>'exact_location', stored_exact;
  end if;
  if (d->>'exact_location_known')::boolean is not true then
    raise exception 'FIX FAILED: a captured address reported exact_location_known=false';
  end if;
  if d->>'exact_location' = d->>'location' then
    raise exception 'FIX FAILED: exact_location equals the masked label — no address was recovered';
  end if;
  raise notice 'discriminates: detail.location = %, detail.exact_location = %', d->>'location', d->>'exact_location';

  -- A city-granularity gig captures no exact label. It must still be REPORTED, with
  -- the flag saying the address is unknown rather than a finding vanishing.
  delete from public.job_locations where job_id = jid;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'a gig with no captured address dropped off the board entirely';
  end if;
  if (d->>'exact_location_known')::boolean is not false then
    raise exception 'reported exact_location_known=true with no job_locations row';
  end if;
  if d->>'exact_location' is distinct from stored_masked then
    raise exception 'the fallback did not degrade to the masked label (%)', d->>'exact_location';
  end if;
  raise notice 'a gig with no exact address still reports, flagged unknown — the LEFT join is load-bearing';

  -- And the 20260806230000 predicate is untouched: an earner who tapped done is not a
  -- safety event, and re-adding the address must not have re-opened that false page.
  update public.bookings set earner_done = true where id = bid;
  if exists (select 1 from public.ctl_safety_checkin_overdue() where entity_id = bid::text) then
    raise exception 'REGRESSION: fired for an earner who already marked themselves done';
  end if;
  raise notice 'the earner_done exclusion survived the redefinition';

  if not exists (select 1 from public.controls
                  where key = 'safety_checkin_overdue' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'overdue-address probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
