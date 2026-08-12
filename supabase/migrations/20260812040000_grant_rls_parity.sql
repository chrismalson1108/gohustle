-- ─────────────────────────────────────────────────────────────────────────────
-- Make the GRANT layer agree with the RLS layer. 131 commands across 28 tables.
--
-- Chris asked what to do about payments granting INSERT/DELETE to anon and
-- authenticated while RLS has only SELECT policies. A sweep says it is not one
-- table's sloppiness: 56 (table, role) pairs hold privileges that no policy backs.
--
-- ── NONE OF THIS IS EXPLOITABLE TODAY, AND THAT IS THE POINT ────────────────
--
-- With RLS enabled, a command with no policy is DENIED. Every one of these 131 is
-- refused right now, and no table in public has RLS disabled — that was checked
-- first, because a granted table with RLS off would be a live hole rather than
-- drift, and there are none.
--
-- What the drift costs is the SECOND line of defence. Today a single careless
-- `create policy x on t for all using (true)` converts a granted-but-denied command
-- straight into a breach, with nothing behind it. With the grants removed, the same
-- mistake grants nothing, because the role has no privilege to exercise. Defence in
-- depth is only depth if the layers are independent.
--
-- stripe_accounts and stripe_customers are the sharpest: an UPDATE policy written
-- there in a hurry would let a user point someone else's payouts at their own Stripe
-- account. legal_documents is next — INSERT there is the ability to publish terms.
--
-- ── ROLE-SPECIFIC ON PURPOSE ────────────────────────────────────────────────
--
-- A first pass aggregated by table and would have revoked INSERT on categories from
-- authenticated, breaking community category creation (ensureCategory) — the one
-- write on that table the product genuinely uses. categories_insert_community backs
-- authenticated INSERT; only anon's is unbacked. Every line below is per role, and
-- the assertions at the end fail the migration if a policied command was caught.
--
-- ── WHAT IS DELIBERATELY NOT DONE ───────────────────────────────────────────
--
-- profiles.xp / streak_days / weekly_jobs_done stay writable by their owner. An audit
-- pass suggested pinning them in guard_profiles_write on the grounds that XP is
-- written server-side; it is not — UserContext.addXP writes profiles.xp directly
-- through the debounced client sync (src/context/UserContext.js:296,306), so pinning
-- them would silently break gamification. Forging them costs a cosmetic level on a
-- public profile; the columns that carry money and trust (rating, verified,
-- earnings_total) are already pinned. The real fix is moving XP awards server-side,
-- which is a change to make deliberately rather than as a side effect of this one.
-- ─────────────────────────────────────────────────────────────────────────────

revoke DELETE,INSERT,SELECT,UPDATE on public.assistant_rate from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.assistant_rate from authenticated;
revoke DELETE,INSERT,SELECT,UPDATE on public.beta_allowlist from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.beta_allowlist from authenticated;
revoke UPDATE on public.blocks from anon;
revoke UPDATE on public.blocks from authenticated;
revoke DELETE on public.bookings from anon;
revoke DELETE on public.bookings from authenticated;
revoke DELETE,INSERT,UPDATE on public.categories from anon;
revoke DELETE,UPDATE on public.categories from authenticated;
revoke DELETE,INSERT,UPDATE on public.category_groups from anon;
revoke DELETE,INSERT,UPDATE on public.category_groups from authenticated;
revoke UPDATE on public.certifications from anon;
revoke UPDATE on public.certifications from authenticated;
revoke DELETE on public.conversation_state from anon;
revoke DELETE on public.conversation_state from authenticated;
revoke DELETE,INSERT on public.disputes from anon;
revoke DELETE,INSERT on public.disputes from authenticated;
revoke UPDATE on public.favorites from anon;
revoke UPDATE on public.favorites from authenticated;
revoke UPDATE on public.job_requirements from anon;
revoke UPDATE on public.job_requirements from authenticated;
revoke DELETE,UPDATE on public.legal_acceptances from anon;
revoke DELETE,UPDATE on public.legal_acceptances from authenticated;
revoke DELETE,INSERT,UPDATE on public.legal_documents from anon;
revoke DELETE,INSERT,UPDATE on public.legal_documents from authenticated;
revoke DELETE,UPDATE on public.messages from anon;
revoke DELETE,UPDATE on public.messages from authenticated;
revoke DELETE,INSERT,UPDATE on public.moderation_flags from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.moderation_flags from authenticated;
revoke DELETE,INSERT,SELECT,UPDATE on public.moderation_rate from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.moderation_rate from authenticated;
revoke DELETE on public.notification_preferences from anon;
revoke DELETE on public.notification_preferences from authenticated;
revoke DELETE,INSERT on public.notifications from anon;
revoke DELETE,INSERT on public.notifications from authenticated;
revoke DELETE,INSERT on public.payments from anon;
revoke DELETE,INSERT on public.payments from authenticated;
revoke DELETE on public.profiles from anon;
revoke DELETE on public.profiles from authenticated;
revoke DELETE,INSERT,SELECT,UPDATE on public.push_send_rate from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.push_send_rate from authenticated;
revoke DELETE,UPDATE on public.referrals from anon;
revoke DELETE,UPDATE on public.referrals from authenticated;
revoke DELETE,UPDATE on public.reports from anon;
revoke DELETE,UPDATE on public.reports from authenticated;
revoke DELETE,UPDATE on public.reviews from anon;
revoke DELETE,UPDATE on public.reviews from authenticated;
revoke DELETE,INSERT,UPDATE on public.stripe_accounts from anon;
revoke DELETE,INSERT,UPDATE on public.stripe_accounts from authenticated;
revoke DELETE,INSERT,UPDATE on public.stripe_customers from anon;
revoke DELETE,INSERT,UPDATE on public.stripe_customers from authenticated;
revoke DELETE,INSERT,SELECT,UPDATE on public.student_email_verifications from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.student_email_verifications from authenticated;
revoke DELETE,INSERT,UPDATE on public.tip_ledger from anon;
revoke DELETE,INSERT,SELECT,UPDATE on public.tip_ledger from authenticated;

-- ── jobs: a hard DELETE path with no product behind it ──────────────────────
-- JobsContext.deleteJob soft-deletes (status:'cancelled'); nothing in either client
-- ever issues a hard DELETE. The row-level damage is already contained —
-- guard_jobs_delete refuses a job with a confirmed/completed/verified booking, and
-- guard_job_slot_settlement_anchor catches pending ones on the slot cascade — so this
-- is not a live hole either. But an unused write path that cascades to bookings,
-- messages, payments, disputes and tip_ledger is worth closing rather than guarding.
-- Account erasure runs as service_role and is unaffected.
drop policy if exists jobs_delete_own on public.jobs;
revoke delete on public.jobs from anon, authenticated;

-- ── One SELECT policy on profiles, not two identical ones ───────────────────
-- A leftover from the original schema.sql duplicating profiles_select_all. The cost
-- is not performance: anyone later tightening profile visibility (hiding suspended
-- users, honouring blocks) will find one name, edit it, and the surviving USING(true)
-- will keep every profile readable — a fix that reports success and changes nothing.
drop policy if exists "profiles are viewable by everyone" on public.profiles;

-- ── Assert the product still has the privileges it actually uses ────────────
do $$
begin
  -- Community categories (ensureCategory) — the case the first pass would have broken.
  if not has_table_privilege('authenticated', 'public.categories', 'INSERT') then
    raise exception 'regression: authenticated lost INSERT on categories';
  end if;
  -- The paths every session depends on.
  if not has_table_privilege('authenticated', 'public.bookings', 'INSERT')
     or not has_table_privilege('authenticated', 'public.jobs', 'INSERT')
     or not has_table_privilege('authenticated', 'public.messages', 'INSERT')
     or not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.support_tickets', 'SELECT')
     or not has_table_privilege('authenticated', 'public.support_ticket_messages', 'INSERT')
     or not has_table_privilege('authenticated', 'public.payments', 'SELECT') then
    raise exception 'regression: a privilege the app uses was revoked';
  end if;
  raise notice 'grant/RLS parity applied; product privileges intact';
end $$;
