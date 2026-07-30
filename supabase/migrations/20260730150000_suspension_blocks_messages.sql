-- ─────────────────────────────────────────────────────────────────────────────
-- Suspension must stop messages too (2026-07-30).
--
-- Suspending someone bans the auth user, flags profiles.suspended_at and revokes
-- live sessions — but the admin action's own success text is explicit that a
-- session already in flight "ends when its token expires (up to ~1h)". So there is
-- an hour in which a suspended account still holds a valid JWT.
--
-- 20260726070000 made suspension bite at the DB layer for two things that do not
-- care about that token: their gigs vanish from Browse (jobs_select_all) and no new
-- booking can involve them (guard_booking_not_suspended). Messages were not covered.
--
-- That is the gap that matters, because of WHY accounts get suspended. Suspension is
-- the safety kill switch — it is used when someone is believed to be a risk to
-- another user, which in practice means harassment. messages_insert is party-scoped,
-- so the people a suspended account can still reach are precisely its existing
-- booking counterparties: the person who most likely just reported them. An hour of
-- continued contact with that person is the exact outcome suspending was meant to
-- stop.
--
-- (Posting a new gig in that window is already neutered — jobs_select_all hides a
-- suspended poster's listings from everyone else, so the gig is invisible the moment
-- it exists. Messaging had no such backstop.)
--
-- Only the SENDER is checked. Blocking the counterparty from messaging a
-- just-suspended user would punish the wrong person — unlike bookings, where the
-- check is bidirectional because both sides have to be able to perform.
--
-- Reads are untouched: a suspended user can still see their conversations, they just
-- cannot add to them. private.is_suspended is the same SECURITY DEFINER helper
-- 20260726070000 introduced — housed in the non-exposed `private` schema so it
-- cannot be called as an RPC oracle over who is suspended, and already granted to
-- authenticated.
--
-- Generated from 20260710030000 (the LATEST definition) by scripted replacement and
-- diffed: one clause added, the party condition and the block check preserved
-- verbatim. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id
      and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
      and not private.is_blocked_pair(b.earner_id, j.poster_id)
      and not private.is_suspended(auth.uid())
  )
);
