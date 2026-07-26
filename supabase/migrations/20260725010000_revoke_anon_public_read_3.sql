-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (LOW, defense-in-depth): finish the anon-grant sweep — round 3
-- (2026-07-25).
--
-- 20260710020000_revoke_anon_public_read.sql revoked the anon SELECT grant on
-- `profiles` + `jobs`; 20260715030000_revoke_anon_public_read_2.sql caught four
-- more (`reviews`, `certifications`, `job_slots`, `job_requirements`). Probing
-- production with the embedded anon key shows fourteen owner-scoped tables still
-- carry the default anon grant — they answer /rest/v1 with 200 rather than the
-- 42501 the swept tables return:
--
--   conversation_state  push_tokens   notifications      blocks
--   expenses            income_entries legal_acceptances favorites
--   saved_jobs          referrals      moderation_flags  assistant_threads
--   assistant_messages  tip_ledger
--
-- NOT a live leak, and deliberately filed as low: every one of these is gated by
-- an owner-scoped RLS policy (`auth.uid() = user_id` or equivalent), and anon has
-- no auth.uid(), so all fourteen return zero rows today. Each was checked for a
-- `USING (true)` policy — none has one.
--
-- It is still worth closing, because the grant is the thing standing between
-- "RLS is the only control" and "there are two controls". Both prior rounds were
-- themselves follow-ups for tables missed by the round before, and the failure
-- mode is quiet: any future policy on these tables that evaluates true for an
-- unauthenticated caller (a `USING (true)` convenience policy, a public-feed
-- feature, a policy that forgets to check auth.uid() is not null) turns straight
-- into anonymous bulk read. Revoking the grant makes that class of mistake fail
-- closed instead.
--
-- `legal_documents` is deliberately NOT revoked — the marketing site renders
-- Terms/Privacy pre-login and needs anonymous read (public read by design, per
-- CLAUDE.md § Legal docs).
--
-- The `authenticated` grants are untouched, so every signed-in flow is unchanged;
-- only the pre-login/anon-key path is closed. Guarded per-table so this stays
-- idempotent and safe if a table is renamed or dropped later.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  targets text[] := array[
    'conversation_state', 'push_tokens', 'notifications', 'blocks',
    'expenses', 'income_entries', 'legal_acceptances', 'favorites',
    'saved_jobs', 'referrals', 'moderation_flags', 'assistant_threads',
    'assistant_messages', 'tip_ledger'
  ];
begin
  foreach t in array targets loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('revoke select on public.%I from anon', t);
    end if;
  end loop;
end $$;

-- Verify post-deploy — each must now return 42501 "permission denied" for anon:
--   for t in conversation_state push_tokens notifications blocks expenses \
--            income_entries legal_acceptances favorites saved_jobs referrals \
--            moderation_flags assistant_threads assistant_messages tip_ledger; do
--     curl -s -o /dev/null -w "$t %{http_code}\n" \
--       "$SUPABASE_URL/rest/v1/$t?select=*&limit=1" -H "apikey: $ANON_KEY"
--   done
-- ...and legal_documents must STILL return 200 (public by design).
