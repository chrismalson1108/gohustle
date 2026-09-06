-- ─────────────────────────────────────────────────────────────────────────────
-- The one control whose subject is a PERSON pages the on-call with a city name.
--
-- jobs.location is masked at write (trg_mask_job_location → capture_job_location) and
-- the exact street label lives in job_locations behind RLS. ctl_safety_checkin_overdue
-- — severity 'critical', "A worker started a gig and has not checked out" — emits
-- `'location', j.location`, which is the MASKED column. So the finding that reaches a
-- human at 11pm about someone who started work six hours ago and has not been heard
-- from says "Plano, TX".
--
-- The control is SECURITY DEFINER, so the exact label was available to it the whole
-- time; nothing was protecting anything by leaving it out. The design memo for this
-- feature (20260806180000) says a masked location "helps nobody at 11pm" — that premise
-- was honoured for the friend's share page (20260806200000, view_gig_share returns the
-- exact label to whoever holds the token) and never for the people the pager is aimed
-- at, who are the ones expected to send help.
--
-- LEFT join, deliberately. A remote or city-only gig has no job_locations row at all,
-- and an inner join would drop those bookings out of a SAFETY control entirely — a
-- worse failure than the one being fixed. exact_location is simply null there, which is
-- honest: it says the platform does not know, rather than implying the city IS the
-- address.
--
-- Everything else about the control is preserved exactly, including the
-- `not coalesce(b.earner_done, false)` clause added by 20260806230000 — an earner who
-- tapped done is not a safety event, and re-introducing those false pages is how the
-- real one gets ignored.
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
           'location', j.location,
           -- The address a person can actually be sent to. Null when the gig never
           -- carried one (remote, or a city-level label the masker left alone).
           'exact_location', l.exact_location,
           'started_at', b.started_at,
           'due_at', c.due_at,
           'hours_overdue', round(extract(epoch from now() - c.due_at) / 3600.0, 1),
           'nudged', c.nudged_at is not null,
           'booking_status', b.status)
    from public.safety_checkins c
    join public.bookings b on b.id = c.booking_id
    join public.jobs j     on j.id = b.job_id
    left join public.job_locations l on l.job_id = j.id
   where c.resolved_at is null
     and c.due_at < now()
     and b.status not in ('completed', 'verified', 'cancelled', 'declined')
     -- The earner said they were done. Waiting on the POSTER is not a safety event.
     and not coalesce(b.earner_done, false)
$$;

revoke execute on function public.ctl_safety_checkin_overdue() from public, anon, authenticated;


-- ── Prove the finding now names a place, and still names the ones with no address ──
do $$
declare
  uid uuid; jid uuid; bid uuid;
  masked text; exact_label text; d jsonb; n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'overdue checkin address probe', 'Odd Jobs', 100, 'flat',
          '4212 Legacy Drive, Plano, TX', 'probe', 'open')
  returning id into jid;

  select location into masked from public.jobs where id = jid;
  select exact_location into exact_label from public.job_locations where job_id = jid;
  if exact_label is null then
    raise exception 'staging is wrong: the masker did not capture an exact address';
  end if;
  if masked = exact_label then
    raise exception 'staging is wrong: jobs.location was not masked, so there is nothing to fix';
  end if;
  raise notice 'staged: jobs.location is %, the address is %', masked, exact_label;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'confirmed')
  returning id into bid;
  -- The real path: setting started_at opens the check-in via trg_z_open_safety_checkin.
  update public.bookings set started_at = now() - interval '6 hours' where id = bid;
  if not exists (select 1 from public.safety_checkins where booking_id = bid) then
    raise exception 'staging is wrong: starting work did not open a check-in';
  end if;
  update public.safety_checkins set due_at = now() - interval '2 hours' where booking_id = bid;

  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d is null then
    raise exception 'the overdue worker did not reach the board at all';
  end if;

  -- THE FIX: the on-call can be told where to go.
  if d->>'exact_location' is distinct from exact_label then
    raise exception 'FIX FAILED: finding carries exact_location=% for address %',
      coalesce(d->>'exact_location', '<null>'), exact_label;
  end if;
  -- THE DISCRIMINATION: the field the old body emitted is the city, and it is not the
  -- address. Both are kept — the masked one is what the parties saw.
  if d->>'location' is distinct from masked then
    raise exception 'the masked label was lost; the finding no longer matches the listing';
  end if;
  if d->>'location' = d->>'exact_location' then
    raise exception 'masked and exact are identical, so this probe proves nothing';
  end if;
  raise notice 'discriminates: old shape offered only "%", the finding now also carries "%"',
    d->>'location', d->>'exact_location';

  -- A gig with no stored address must STILL be reported. An inner join here would drop
  -- remote and city-only gigs out of a safety control, which is worse than the bug.
  delete from public.job_locations where job_id = jid;
  select count(*) into n from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if n <> 1 then
    raise exception 'a gig with no stored address fell out of the control entirely (% rows)', n;
  end if;
  select detail into d from public.ctl_safety_checkin_overdue() where entity_id = bid::text;
  if d->>'exact_location' is not null then
    raise exception 'claimed an address for a gig that has none';
  end if;
  raise notice 'a gig with no stored address is still reported, with exact_location null';

  if not exists (select 1 from public.controls
                  where key = 'safety_checkin_overdue' and fn_name = 'ctl_safety_checkin_overdue'
                    and severity = 'critical') then
    raise exception 'not registered as critical — the sweep would not page for it';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'overdue-checkin address probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
