-- ─────────────────────────────────────────────────────────────────────────────
-- The SOS exemption was a rate-limiter bypass for any authenticated user.
--
-- 20260806200000 exempted emergencies from the 10-reports-per-hour limiter, on the
-- stated reasoning that only raise_gig_emergency can set source='emergency' because
-- "guard_reports_write pins everything else to 'user'".
--
-- That is true of the STORED ROW and false at the moment the limiter reads it. Postgres
-- fires same-timing triggers in ALPHABETICAL NAME ORDER, and:
--
--     trg_guard_report_rate_limit    <- fires FIRST  ('_' sorts before 's')
--     trg_guard_reports_write        <- pins source AFTERWARDS
--
-- So when the limiter evaluates `new.source`, it is still holding whatever the CLIENT
-- sent. Any authenticated user could insert with source='emergency' and skip the limit
-- entirely; guard_reports_write then quietly rewrote it to 'user', so the stored row
-- looked perfectly ordinary and nothing recorded that the limit had been skipped.
--
-- Blast radius is not just spam. trg_notify_safety_report is an AFTER INSERT trigger
-- that issues one net.http_post per report, so an unbounded insert loop is also an
-- unbounded alert-dispatch loop against the safety channel — the exact "flood the pager
-- until it is useless" shape, reachable by anyone with an account.
--
-- ── FIXED TWICE, DELIBERATELY ───────────────────────────────────────────────
--
-- 1. THE CHECK IS NOW ORDER-INDEPENDENT. The limiter tests the app.emergency GUC
--    directly — the same thing guard_reports_write trusts, set transaction-locally by
--    raise_gig_emergency and unreachable over PostgREST. A client-supplied column can
--    never satisfy it, whatever order the triggers run in.
--
-- 2. THE ORDER IS FIXED ANYWAY, so `new.source` is TRUE for any future reader. Renaming
--    the limiter to the trg_z_ prefix already used for late-running triggers in this
--    schema (trg_z_pin_booking_amount, trg_zz_release_benefits) makes the pinning guard
--    run first. Relying on either fix alone would leave the next person to touch this
--    file one plausible assumption away from reopening the hole.
--
-- The emergency path itself is unchanged: a genuine SOS is still exempt, and
-- ctl_emergency_flood still bounds repeated emergencies by alerting a human rather than
-- by refusing someone in danger.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count int;
  report_limit_per_hour constant int := 10;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- An emergency is not a report, and a limiter built to stop report spam must never be
  -- the reason someone in danger cannot raise an alarm.
  --
  -- TEST THE GUC, NOT new.source. The column is client-supplied and, depending on
  -- trigger order, may not have been pinned yet — that was the bypass. The GUC is set
  -- only inside raise_gig_emergency, is transaction-local, and is not reachable over
  -- PostgREST, so it is the only trustworthy evidence of provenance here.
  if coalesce(current_setting('app.emergency', true), '') = 'on' then
    return new;
  end if;

  select count(*) into recent_count
  from public.reports r
  where r.reporter_id = auth.uid()
    and coalesce(r.source, 'user') <> 'auto'
    and r.created_at > now() - interval '1 hour';

  if recent_count >= report_limit_per_hour then
    raise exception
      'You have filed several reports in a short time. If someone is in danger, contact support or emergency services directly.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_report_rate_limit() from public, anon, authenticated;

-- ── Make the ordering match the intent ──────────────────────────────────────
-- guard_reports_write must pin source BEFORE anything reads it.
drop trigger if exists trg_guard_report_rate_limit on public.reports;
drop trigger if exists trg_z_guard_report_rate_limit on public.reports;
create trigger trg_z_guard_report_rate_limit
  before insert on public.reports
  for each row execute function public.guard_report_rate_limit();
