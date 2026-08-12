-- ─────────────────────────────────────────────────────────────────────────────
-- I dropped a WHERE clause while re-creating a function. Fourth time today.
--
-- 20260812090000 rewrote ctl_live_booking_without_schedule_anchor to add a date
-- floor, and lost `b.status in ('confirmed','completed')` in the process. The control
-- immediately began reporting CANCELLED and PENDING bookings as live bookings with no
-- settlement anchor — findings went 1 → 3 rather than 1 → 0, which is the only reason
-- I noticed.
--
-- A cancelled booking has nothing left to settle, so it can never need an anchor.
-- Reporting it is not a harmless extra row: this control is HIGH severity and pages,
-- and a control that cries about finished work is one people mute.
--
-- The clause is restored, and the migration ASSERTS the property directly against the
-- live data afterwards rather than trusting that I read my own SQL correctly — which
-- is the step that was missing every previous time.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_live_booking_without_schedule_anchor()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'reason', case
             when b.slot_id is null then 'no_slot_id'
             when s.id is null then 'slot_missing'
             when s.job_id <> b.job_id then 'slot_belongs_to_other_job'
             else 'slot_has_no_starts_at' end,
           'booking_status', b.status,
           'slot_id', b.slot_id,
           'slot_label', s.label,
           'job_id', b.job_id,
           'earner_id', b.earner_id,
           'created_at', b.created_at,
           'note', 'a live booking with no settlement anchor — flexible slots are '
                   'excluded because they carry no start time by design')
    from public.bookings b
    left join public.job_slots s on s.id = b.slot_id
   -- LIVE ONLY. Dropping this is the regression this migration exists to fix: a
   -- cancelled or declined booking has nothing left to settle.
   where b.status in ('confirmed','completed')
     -- starts_at did not exist before this date (earliest non-null in either
     -- bookings or job_slots is 2026-06-30, the day escrow launched).
     and b.created_at >= timestamptz '2026-06-30'
     -- The booking's own anchor counts, not just the slot's.
     and b.starts_at is null
     and (b.slot_id is null
          or s.id is null
          or s.job_id <> b.job_id
          or (s.starts_at is null
              -- A flexible slot carries no start time by design.
              and coalesce(s.label, '') <> 'Flexible — Contact to Schedule'))
$$;

revoke execute on function public.ctl_live_booking_without_schedule_anchor() from public, anon, authenticated;

-- ── Assert against real rows, not against my reading of the SQL ─────────────
do $$
declare
  bad text;
begin
  select string_agg(format('%s(%s)', entity_id, detail->>'booking_status'), ', ')
    into bad
    from public.ctl_live_booking_without_schedule_anchor()
   where detail->>'booking_status' not in ('confirmed','completed');
  if bad is not null then
    raise exception 'control still reports non-live bookings: %', bad;
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.run_all_controls();
  raise notice 'anchor control reports only live bookings; open findings now %',
    (select count(*) from public.control_findings where resolved_at is null);
end $$;
