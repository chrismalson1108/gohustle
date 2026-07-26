-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (HIGH, abuse): rate-limit user-filed safety reports (2026-07-26).
--
-- H6 (20260710050000_safety_report_alerting.sql) wired an AFTER INSERT trigger on
-- public.reports that pages a human — a harassment/assault report must not sit in a
-- poll-only queue. That is the right call, and it is exactly what makes the missing
-- rate limit dangerous: `reports_insert_own` pins only reporter_id, and there is no
-- cap anywhere (no trigger, no CHECK, no ledger — the edge-function limiters cover
-- assistant/push/moderation, not this table, because reports are written straight to
-- PostgREST by the client).
--
-- So one authenticated account can loop INSERT /rest/v1/reports and:
--   * fire the on-call safety pager arbitrarily many times (each insert notifies), and
--   * bury every genuine report under fabricated ones in the admin moderation queue.
-- Both degrade the control the platform relies on to keep people physically safe, and
-- the second is the more insidious: the real report is still there, just unfindable.
--
-- Fix: a BEFORE INSERT trigger capping a single reporter at REPORT_LIMIT_PER_HOUR.
-- reports is its own ledger (it has reporter_id + created_at), so no side table is
-- needed. The cap is deliberately generous — a genuine user filing more than ten
-- reports in an hour is already an outlier worth a human look, and the error text
-- routes them to support rather than silently dropping a real safety issue.
--
-- Service role bypasses, matching every other guard_*: auto-moderation writes
-- source='auto' rows (20260715010000) through the service client and must never be
-- throttled by a user's quota.
-- Idempotent.
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

  -- Count this reporter's own recent rows. SECURITY DEFINER so the count is not
  -- itself filtered by reports_select_own (it would match anyway, but the guard must
  -- not depend on an RLS policy that could later be narrowed).
  select count(*) into recent_count
  from public.reports r
  where r.reporter_id = auth.uid()
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

-- Verify post-deploy: as one signed-in user, POST /rest/v1/reports eleven times in an
-- hour — the first ten succeed, the eleventh returns check_violation. A service-role
-- insert (source='auto') must succeed regardless of the user's count.
