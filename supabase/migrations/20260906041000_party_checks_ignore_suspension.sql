-- ─────────────────────────────────────────────────────────────────────────────
-- Suspending a poster deletes their counterparty's evidence — from the counterparty.
--
-- 20260726070000 redefined jobs_select_all as
--   `poster_id = auth.uid() or not private.is_suspended(jobs.poster_id)`
-- so a suspended poster's listings vanish from Browse. Its own header scopes the intent
-- to exactly that (:20-23, "hide a suspended poster's listings from everyone EXCEPT the
-- poster themselves") plus blocking NEW bookings. It says nothing about the people who
-- already have a booking with them.
--
-- But an RLS policy's subquery is evaluated as the QUERYING role, so RLS on the tables it
-- reads applies too — the exact reason this repo built private.is_blocked_pair as
-- SECURITY DEFINER (20260710030000:18-30). And every party-scoped policy in the platform
-- establishes "party" by INNER JOINing public.jobs:
--
--   messages_read            (migration_fix_lifecycle.sql:95)
--   messages_insert          (20260730150000:41)
--   disputes_select_parties  (migration_location_tips_disputes.sql:22)
--   chat_photos_party_read   (20260701000000:25, storage.objects)
--   completion_party_read    (20260707010000:25, storage.objects)
--
-- For the EARNER on a suspended poster's booking the jobs row is filtered out, the inner
-- join yields nothing, and the EXISTS is false. So the moment a poster is suspended the
-- earner loses: the whole message thread, the ability to reply into it, the poster's chat
-- photos, the completion photos, and any dispute row on the booking.
--
-- ── WHY THIS IS THE WORST POSSIBLE MOMENT TO LOSE IT ────────────────────────
-- Suspension is the safety kill switch. RUNBOOK_SAFETY has staff suspend the reported
-- party and then (step 4) contact the reporter about the case. At that instant the
-- reporter can no longer open the conversation they reported — the harassment they were
-- asked about is gone from their own app.
--
-- And it does not read as a policy effect. bookings_select_parties' earner branch is
-- `auth.uid() = earner_id` with no jobs join, and job_locations_party_read's earner branch
-- reads only bookings, so the booking card and the address survive while the thread
-- empties. src/components/MessageSheet.js:141-160 treats a zero-row result as a normal
-- empty thread (only an `error` sets loadError), and the embedded job comes back null so
-- shared/transforms.js renders 'Gig no longer listed'. To the earner it looks like their
-- evidence was deleted. To staff, on service_role, everything is still there. Unsuspending
-- silently restores it all, so nobody ever sees the failure.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Make the party test suspension-agnostic the same way blocks and suspension were each
-- made real: a SECURITY DEFINER helper in the non-exposed `private` schema, so the jobs
-- read happens as the owner and no longer passes through jobs_select_all.
--
-- jobs_select_all is deliberately left alone. Hiding a suspended poster's listings from
-- Browse is correct and is not what breaks here; what breaks is other policies borrowing
-- that visibility rule as an authorization test it was never meant to be.
--
-- No authorization is widened. Each policy keeps exactly the condition it had —
-- "is this caller the booking's earner or the job's poster" — evaluated over the same two
-- rows. The only thing that changes is that the answer no longer depends on whether the
-- caller is allowed to browse the job.
--
-- messages_insert additionally keeps its block check (20260710030000) and its
-- suspended-sender check (20260730150000), unchanged in meaning: the block probe moves
-- into a second private helper because it too needs the job's poster_id.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The party test, evaluated as the owner ───────────────────────────────
-- SECURITY DEFINER and housed in `private` for the same two reasons is_blocked_pair and
-- is_suspended are (20260710030000:18-30, 20260726070000:36-45):
--   (a) an inline subquery in a policy runs as the QUERYING role, so it inherits
--       jobs_select_all — which now hides suspended posters' jobs and therefore hides the
--       party relationship from the innocent counterparty. Running as the owner reads the
--       booking/job pair for what it is.
--   (b) `private` is not served by PostgREST, so this cannot be reached as
--       /rest/v1/rpc/... and turned into an oracle over who is party to which booking.
-- Returns false for a null uid (anon) and for a booking or job that does not exist, so it
-- fails closed.
create or replace function private.is_booking_party(p_booking uuid, p_uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select p_uid is not null and exists (
    select 1
      from public.bookings b
      join public.jobs j on j.id = b.job_id
     where b.id = p_booking
       and (b.earner_id = p_uid or j.poster_id = p_uid)
  );
$$;

revoke execute on function private.is_booking_party(uuid, uuid) from public, anon;
grant execute on function private.is_booking_party(uuid, uuid) to authenticated;

-- The block probe for messages_insert. It needs the job's poster_id, which is precisely
-- the read that jobs_select_all was filtering, so it moves in here with the party test.
-- Boolean-only and party-agnostic on purpose: a helper that returned the poster's id
-- would be an identity oracle where this is only ever a yes/no gate.
-- Returns false when the booking or job is missing — safe, because the policy also
-- requires is_booking_party, which is false in that case.
create or replace function private.booking_parties_blocked(p_booking uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.bookings b
      join public.jobs j on j.id = b.job_id
     where b.id = p_booking
       and private.is_blocked_pair(b.earner_id, j.poster_id)
  );
$$;

revoke execute on function private.booking_parties_blocked(uuid) from public, anon;
grant execute on function private.booking_parties_blocked(uuid) to authenticated;

-- ── 2. The five party-scoped policies ───────────────────────────────────────

-- Reads stay untouched in meaning: both parties can read the thread. A suspended user can
-- still see their conversations (20260730150000 was explicit about that); so can the
-- person on the other side of a suspended one, which is the whole point of this file.
drop policy if exists "messages_read" on public.messages;
create policy "messages_read" on public.messages for select using (
  private.is_booking_party(booking_id, auth.uid())
);

-- Same three clauses as 20260730150000, with the party and block tests taken off the
-- jobs-visibility path. The suspended-SENDER check is unchanged and still one-sided:
-- blocking the counterparty from replying would punish the wrong person.
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert with check (
  sender_id = auth.uid()
  and private.is_booking_party(booking_id, auth.uid())
  and not private.booking_parties_blocked(booking_id)
  and not private.is_suspended(auth.uid())
);

drop policy if exists "disputes_select_parties" on public.disputes;
create policy "disputes_select_parties" on public.disputes for select using (
  auth.uid() = raised_by
  or private.is_booking_party(booking_id, auth.uid())
);

-- storage.objects: the object-matching half is unchanged (including the legacy full-URL
-- form); only the party half moves to the helper. The subquery still reads public.messages
-- under the caller's own RLS, which after the fix above is the SAME predicate — so the
-- storage policy can never be looser than message visibility, and is no longer narrower.
drop policy if exists "chat_photos_party_read" on storage.objects;
create policy "chat_photos_party_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-photos'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1
        from public.messages m
        where (
                m.image_url = storage.objects.name
                or m.image_url like '%/chat-photos/' || storage.objects.name
              )
          and private.is_booking_party(m.booking_id, auth.uid())
      )
    )
  );

-- Same for completion photos. bookings' own RLS is already suspension-agnostic
-- (bookings_select_parties' earner branch is `auth.uid() = earner_id`, and its poster
-- branch reads the poster's own job, which jobs_select_all always shows them), so the
-- remaining read through public.bookings does not reintroduce the problem.
drop policy if exists "completion_party_read" on storage.objects;
create policy "completion_party_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'completion-photos'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1
        from public.bookings b
        cross join lateral unnest(
          coalesce(b.completion_photos, '{}'::text[]) || coalesce(b.before_photos, '{}'::text[])
        ) as photo(val)
        where private.is_booking_party(b.id, auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
    )
  );

-- ── Prove it, as the earner, against a suspended poster ─────────────────────
-- Staged rows only, and the block ends by raising so everything rolls back. The probe
-- runs as `authenticated` (set_config('role', …) — the pattern from 20260812050000:113),
-- because as the table owner RLS does not apply at all and the bug is invisible.
do $$
declare
  poster uuid; earner uuid;
  jid uuid; bid uuid;
  chat_obj text; done_obj text;
  old_shape boolean; new_shape boolean;
  n_msg int; n_dispute int;
  old_chat boolean; new_chat boolean;
  old_done boolean; new_done boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into poster from public.profiles where deleted_at is null and suspended_at is null limit 1;
  select id into earner from public.profiles
   where deleted_at is null and suspended_at is null and id <> poster limit 1;
  if poster is null or earner is null then
    raise exception 'need two live profiles to stage a booking against';
  end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (poster, 'suspension party probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'confirmed')
  returning id into bid;

  -- The evidence: the poster's message, the poster's photo in it, the earner's completion
  -- photo, and the dispute on the booking.
  chat_obj := poster::text || '/probe-chat.jpg';
  done_obj := earner::text || '/probe-done.jpg';

  insert into public.messages (booking_id, sender_id, text, image_url)
  values (bid, poster, 'probe: the message the reporter reported', chat_obj);

  update public.bookings set completion_photos = array[done_obj] where id = bid;

  insert into public.disputes (booking_id, raised_by, reason, pct_paid)
  values (bid, poster, 'probe', 50);

  -- Staff suspend the poster, per RUNBOOK_SAFETY §1.
  update public.profiles set suspended_at = now() where id = poster;

  -- ── Now be the earner, over PostgREST, with RLS actually applied ──────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', earner::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- The OLD party shape, verbatim from migration_fix_lifecycle.sql:95-101. It is FALSE,
  -- because jobs_select_all hides the suspended poster's job from the earner and the
  -- inner join therefore yields nothing. This is the finding.
  select exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = bid and (b.earner_id = earner or j.poster_id = earner)
  ) into old_shape;

  -- The NEW shape, same question, asked as the owner.
  select private.is_booking_party(bid, earner) into new_shape;

  -- The real policies, exercised end to end as the earner.
  select count(*) into n_msg from public.messages where booking_id = bid;
  select count(*) into n_dispute from public.disputes where booking_id = bid;

  -- The storage predicates. A storage object cannot be staged from a migration, so the
  -- policy's own party half is evaluated directly for each shape — old vs new.
  select exists (
    select 1 from public.messages m
    join public.bookings b on b.id = m.booking_id
    join public.jobs j on j.id = b.job_id
    where m.image_url = chat_obj and (b.earner_id = earner or j.poster_id = earner)
  ) into old_chat;
  select exists (
    select 1 from public.messages m
    where m.image_url = chat_obj and private.is_booking_party(m.booking_id, earner)
  ) into new_chat;

  select exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    cross join lateral unnest(coalesce(b.completion_photos, '{}'::text[])) as photo(val)
    where photo.val = done_obj and (b.earner_id = earner or j.poster_id = earner)
  ) into old_done;
  select exists (
    select 1 from public.bookings b
    cross join lateral unnest(coalesce(b.completion_photos, '{}'::text[])) as photo(val)
    where photo.val = done_obj and private.is_booking_party(b.id, earner)
  ) into new_done;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── Discrimination ───────────────────────────────────────────────────────
  if old_shape then
    raise exception 'the old inline-join shape still resolved the earner as a party — '
                    'this probe is not reproducing the bug it claims to fix';
  end if;
  raise notice 'reproduced: the old `join public.jobs` party test says the earner is NOT a party';

  if not new_shape then
    raise exception 'FIX FAILED: private.is_booking_party does not see the earner as a party';
  end if;
  raise notice 'discriminates: the same question asked as the owner says the earner IS a party';

  if n_msg <> 1 then
    raise exception 'FIX FAILED: the earner reads % message(s) on a suspended poster''s booking, expected 1', n_msg;
  end if;
  raise notice 'messages_read: the reporter can still open the thread they reported';

  if n_dispute <> 1 then
    raise exception 'FIX FAILED: the earner reads % dispute row(s), expected 1', n_dispute;
  end if;
  raise notice 'disputes_select_parties: the dispute on the booking is still visible';

  if old_chat then
    raise exception 'chat-photo probe did not reproduce: the old shape still matched';
  end if;
  if not new_chat then
    raise exception 'FIX FAILED: the earner cannot authorize a signed URL for the poster''s chat photo';
  end if;
  raise notice 'chat_photos_party_read: old shape blind, new shape sees it';

  if old_done then
    raise exception 'completion-photo probe did not reproduce: the old shape still matched';
  end if;
  if not new_done then
    raise exception 'FIX FAILED: the earner cannot authorize a signed URL for the completion photo';
  end if;
  raise notice 'completion_party_read: old shape blind, new shape sees it';

  -- And a non-party is still a non-party — the helper authorizes, it does not open.
  if private.is_booking_party(bid, gen_random_uuid()) then
    raise exception 'FIX WIDENED ACCESS: a stranger resolves as a party to the booking';
  end if;
  if private.is_booking_party(bid, null) then
    raise exception 'FIX WIDENED ACCESS: a null (anon) uid resolves as a party';
  end if;
  raise notice 'a stranger and anon are both still non-parties';

  raise exception 'probe complete — rolling back';
exception when others then
  perform set_config('role', 'postgres', true);
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'suspension/party probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
