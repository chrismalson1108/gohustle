-- ctl_safety_checkin_overdue paged for workers who had already finished.
--
-- The control excluded status in ('completed','verified','cancelled','declined'), which
-- looks complete but is not, because completion is MUTUAL: status only advances to
-- 'completed' once BOTH earner_done and poster_done are true. An earner who finishes the
-- gig and taps done sits at status='confirmed' with earner_done=true for as long as the
-- poster takes to act -- overnight, in practice. The overdue check-in then fires and
-- pages the safety team about someone who checked out hours ago.
--
-- False pages on a safety channel are not a cosmetic problem: they are how the real one
-- gets ignored. The earner tapping done is an explicit "I am finished" and is exactly
-- the signal this control exists to wait for.
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
           'started_at', b.started_at,
           'due_at', c.due_at,
           'hours_overdue', round(extract(epoch from now() - c.due_at) / 3600.0, 1),
           'nudged', c.nudged_at is not null,
           'booking_status', b.status)
    from public.safety_checkins c
    join public.bookings b on b.id = c.booking_id
    join public.jobs j     on j.id = b.job_id
   where c.resolved_at is null
     and c.due_at < now()
     and b.status not in ('completed', 'verified', 'cancelled', 'declined')
     -- The earner said they were done. Waiting on the POSTER is not a safety event.
     and not coalesce(b.earner_done, false)
$$;

revoke execute on function public.ctl_safety_checkin_overdue() from public, anon, authenticated;
