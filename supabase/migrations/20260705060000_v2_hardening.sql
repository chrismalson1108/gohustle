-- ─────────────────────────────────────────────────────────────────────────────
-- Admin console v2 — security-review fixes.
--
--  MEDIUM: reports.resolved_by (staff uuid) + resolution (internal moderator note),
--    added in 20260705050000, leaked to the REPORTER — reports_select_own lets a
--    reporter SELECT their own report rows via PostgREST, and reports had the
--    default table-wide SELECT grant. The user apps only INSERT reports (verified:
--    src/lib/moderation.js + web/lib/moderation.ts), never SELECT, so scoping the
--    SELECT grant to the non-internal columns breaks nothing. service_role bypasses
--    column grants and still reads everything for the console.
--
--  HIGH (edge, code): support-submit anti-abuse — add an ip column so the function
--    can rate-limit by source IP + a global cap, not just the spoofable email field.
-- ─────────────────────────────────────────────────────────────────────────────

revoke select on public.reports from anon, authenticated;
grant select (
  id, reporter_id, reported_user_id, job_id, booking_id, reason, details, created_at, resolved_at
) on public.reports to anon, authenticated;
-- resolved_by + resolution intentionally NOT granted → internal to the console.

alter table public.support_tickets add column if not exists ip text;
create index if not exists support_tickets_ip_idx on public.support_tickets (ip, created_at desc);
