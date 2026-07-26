-- ─────────────────────────────────────────────────────────────────────────────
-- Correctness (MEDIUM, safety): auto-moderation telemetry was eating the user's
-- genuine safety-report quota (2026-07-26).
--
-- 20260726020000 added guard_report_rate_limit, capping a reporter at 10 reports/hour
-- to stop one account flooding the on-call pager and burying real reports. The cap
-- counts rows in public.reports where reporter_id = auth.uid() — with no filter on
-- `source`.
--
-- But public.reports is not only the user-filed abuse queue. It is also the sink for
-- automatic keyword-block telemetry: log-moderation inserts a row carrying
-- `reporter_id: <that user>` and `source: 'auto'` EVERY time their text trips the
-- client-side keyword filter. Those writes go through the service role, so the
-- bypass in the guard correctly lets them in — but they still COUNT against the same
-- user later, because the counting query does not exclude them.
--
-- So the rate limit meant to protect the safety queue could lock a user OUT of it:
--
--   1. an earner types "can you just pay me on Venmo instead?" in chat; the keyword
--      filter blocks the send and logModerationBlock files a source='auto' row
--   2. they rephrase a few times, tripping it again — each attempt is another row,
--      and the user never sees any of them
--   3. after ten, their genuine "this person is harassing me" report is rejected with
--      "You have filed several reports in a short time"
--
-- The person most likely to trip the content filter repeatedly and the person most
-- likely to need the safety queue are not disjoint groups. That migration's own banner
-- states the intent — "auto-moderation writes source='auto' rows ... and must never be
-- throttled by a user's quota" — and the bypass implements that for WRITING while the
-- count still charged them for it.
--
-- Fix: count only user-initiated reports. Auto rows keep their own bound in
-- log-moderation's existing 20-per-5-minute limiter, so nothing becomes unbounded.
--
-- Function generated from 20260726020000 with the single predicate added; everything
-- else, including the service_role bypass and the limit, is unchanged. Idempotent.
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
  -- Auto-moderation / admin writes are not user-initiated and are never throttled.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- Count this reporter's own recent USER-FILED rows. source='auto' rows are
  -- keyword-block telemetry the user never chose to file and cannot see, so charging
  -- them to the safety-report quota would lock people out of reporting real abuse.
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

drop trigger if exists trg_guard_report_rate_limit on public.reports;
create trigger trg_guard_report_rate_limit
  before insert on public.reports
  for each row execute function public.guard_report_rate_limit();

-- Verify post-deploy: trip the keyword filter 10+ times (source='auto' rows accrue),
-- then file a genuine report -> must still succeed. Filing 11 genuine reports in an
-- hour must still be rejected on the 11th.
