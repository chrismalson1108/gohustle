-- ─────────────────────────────────────────────────────────────────────────────
-- Auth audit (2026-07-06): legal_acceptances had no unique constraint and
-- recordAcceptances did a plain insert, so a concurrent tab / re-run of onboarding
-- / a retried /consent accept could pile duplicate (user_id, slug, version) rows
-- into the acceptance audit trail. Enforce one row per (user, slug, version) so the
-- app's new upsert(..., ignoreDuplicates) is idempotent and the audit trail holds
-- exactly one authoritative acceptance per version.
-- ─────────────────────────────────────────────────────────────────────────────

-- Deduplicate any existing rows first (keep the EARLIEST accepted_at = the real
-- first acceptance; break exact-timestamp ties on id) so the unique index can build.
delete from public.legal_acceptances a
using public.legal_acceptances b
where a.user_id = b.user_id
  and a.slug = b.slug
  and a.version = b.version
  and (a.accepted_at > b.accepted_at
       or (a.accepted_at = b.accepted_at and a.id > b.id));

create unique index if not exists legal_acceptances_user_slug_version_uniq
  on public.legal_acceptances (user_id, slug, version);
