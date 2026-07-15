-- ─────────────────────────────────────────────────────────────────────────────
-- H6 pager: only page the on-call for genuine user safety reports (2026-07-15).
--
-- trg_notify_safety_report was created (20260710050000) BEFORE the reports.source
-- column (20260713020000) and fires on EVERY insert with no WHEN clause. Since the
-- moderation work, three service-role paths insert source='auto' rows on every content
-- block (moderate-text — no rate limit, moderate-image, log-moderation), so once the
-- alert GUCs are armed every automated block emails the on-call, flooding the safety
-- inbox, burning Resend quota, and burying real harassment/assault reports.
--
-- Recreate the trigger with a WHEN filter so auto-moderation rows still land in the
-- admin queue (and still fire the AFTER INSERT for other consumers is unnecessary) but
-- never page the human. Only rows that are NOT source='auto' (i.e. genuine user
-- reports) dispatch to safety-alert. The function body is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

drop trigger if exists trg_notify_safety_report on public.reports;
create trigger trg_notify_safety_report
  after insert on public.reports
  for each row
  when (new.source is distinct from 'auto')
  execute function public.notify_safety_report();
