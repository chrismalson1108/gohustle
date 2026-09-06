-- ─────────────────────────────────────────────────────────────────────────────
-- The unread badge compares a DEVICE clock against a SERVER clock, so a phone that
-- is a minute fast hides messages it has never shown anyone.
--
-- markConversationRead (src/lib/messages.js:46-49, and identically
-- web/lib/messages.ts:51-57) writes the read receipt from the handset:
--
--     upsert({ user_id, booking_id, last_read_at: new Date().toISOString() })
--
-- messages.created_at has no client value anywhere — MessageSheet inserts without it
-- (src/components/MessageSheet.js:231,278) and takes the column default
-- `TIMESTAMPTZ DEFAULT NOW()` (supabase/migration_fix_lifecycle.sql:88), i.e. the
-- SERVER's clock. isUnread (messages.js:58-62) then compares the two directly, and it
-- is the only unread test there is: the Messages hub renders the dot from it and
-- JobsContext.refreshUnread (src/context/JobsContext.js:212) counts the tab badge
-- from it.
--
-- conversation_state has no trigger of any kind. Its only DDL is the legacy
-- supabase/migration_conversations.sql (table + three owner policies); the later
-- touches — 20260725010000 and 20260812040000 — are grants and revokes. So whatever
-- the handset sends is what is stored, unchecked, and the comparison is between two
-- clocks that were never synchronised.
--
-- Both directions of skew are wrong, and one of them loses messages:
--
--   • Clock 45s FAST. At server time T the user opens the thread; the receipt is
--     stored as T+45s. The counterparty replies at T+20s. created_at (T+20s) is not
--     greater than last_read_at (T+45s), so the reply is READ ON ARRIVAL: no dot in
--     the hub, no tab badge, and the only remaining signal is a push notification the
--     user may have disabled or dismissed. On a platform where the message thread is
--     how two strangers arrange to meet in person, a silently swallowed "I'm running
--     late" or "I can't make it" is not a cosmetic defect.
--   • Clock 45s SLOW. Every thread the user just read stays flagged unread until it is
--     reopened at least 45 seconds later — a badge that will not clear.
--
-- This project already recognised this exact class and fixed it on the SIBLING table:
-- 20260814030000 clamps support_tickets.user_read_at, on the reasoning that "a skewed
-- device clock is the innocent case; a deliberate future value would park the ticket's
-- read state permanently ahead of every real message." The message read receipt is the
-- same mechanism against the same threat and was simply never covered. The app also
-- already tells users their clock may be wrong (src/lib/mfa.js:124 attributes a failing
-- TOTP code to device time), so this is a condition the product expects to meet.
--
-- ── WHY now() AND NOT A CLAMP TO now() ──────────────────────────────────────
-- The support fix only pulls FUTURE values back, because a support agent's own
-- timeline is reconstructed from that column. Here the client's write carries no
-- information at all: markConversationRead is called at exactly one moment — the
-- moment the thread is opened (MessageSheet.js:107, MessagesScreen.js:131) — and it
-- always means "I am reading this now". So the honest server-side value is now(), and
-- taking it fixes the slow-clock half too, which a future-only clamp cannot.
--
-- ── WHAT MUST NOT BREAK ─────────────────────────────────────────────────────
-- setConversationArchived (messages.js:51-54) upserts { user_id, booking_id, archived }
-- with NO last_read_at, so PostgREST's ON CONFLICT DO UPDATE sets only `archived` and
-- NEW.last_read_at carries OLD's value through. The trigger must therefore rewrite the
-- column only when the write actually CHANGES it — otherwise archiving a conversation
-- would silently mark it read, which is a worse version of the bug being fixed. The
-- probe below asserts that case explicitly.
--
-- A row inserted with no last_read_at at all (archive-first on a thread never opened)
-- must stay NULL, because isUnread treats a missing receipt as unread — the correct
-- default, and the one the hub relies on.
--
-- No client change is needed, which is the point of fixing it here: mobile and web
-- carry the same write, and one trigger covers both plus every older build already
-- installed.
--
-- Note for the probes below: now() is TRANSACTION time, so inside a single DO block
-- the trigger's now() and this block's now() are the same instant. That is why the
-- assertions test `got <> now()` rather than a tolerance window, and why the staged
-- "later reply" carries an explicit created_at rather than relying on the default.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── First, prove the hole is real on the CURRENTLY-LIVE schema ──────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; got timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'read receipt probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'confirmed')
  returning id into bid;

  -- Exactly what the app sends, as the row's own owner: a receipt stamped by a clock
  -- that is not the server's.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  insert into public.conversation_state (user_id, booking_id, last_read_at)
  values (uid, bid, now() + interval '10 years');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select last_read_at into got from public.conversation_state
   where user_id = uid and booking_id = bid;

  if got <= now() then
    raise exception
      'nothing to fix: the live schema already rewrote the device timestamp (got %)', got;
  end if;
  raise notice
    'hole confirmed on the live schema: last_read_at stored as %, so every message this conversation ever receives is read on arrival', got;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'pre-fix probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;


-- ── The fix ─────────────────────────────────────────────────────────────────
create or replace function public.guard_conversation_state_read_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Matches every other guard_*: system writes are trusted. Nothing writes this table
  -- as service_role today; the bypass exists so a future backfill or support tool is
  -- not silently rewritten by a guard aimed at handsets.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- A read receipt is not data the client holds — it is the server's observation that
  -- the client asked for this conversation. markConversationRead is called at the
  -- moment the thread opens and at no other time, so the only value it can honestly
  -- carry is now(). Taking the device's value instead compares a handset clock with
  -- messages.created_at (server now()), and both directions of skew are wrong: fast
  -- marks unseen replies read, slow leaves read threads badged.
  --
  -- Rewritten ONLY when the write changes the column. setConversationArchived upserts
  -- { user_id, booking_id, archived } with no last_read_at, so NEW carries OLD's value
  -- through the ON CONFLICT UPDATE; bumping it there would make archiving a
  -- conversation mark it read.
  if tg_op = 'INSERT' then
    -- A row created by the archive path has no receipt, and must keep none: isUnread
    -- reads a missing last_read_at as unread, which is the correct default.
    if new.last_read_at is not null then
      new.last_read_at := now();
    end if;
  elsif new.last_read_at is distinct from old.last_read_at and new.last_read_at is not null then
    new.last_read_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_conversation_state_read_at() from public, anon, authenticated;

drop trigger if exists trg_guard_conversation_state_read_at on public.conversation_state;
create trigger trg_guard_conversation_state_read_at
  before insert or update on public.conversation_state
  for each row execute function public.guard_conversation_state_read_at();


-- Backfill. A receipt already parked in the future keeps swallowing that
-- conversation's messages until the user opens it again — and if the clock is wrong by
-- more than the gap between reads, indefinitely. now() is the only defensible value:
-- the real read moment is gone, and now() is what the fixed path would have written.
do $$
declare
  n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  with fixed as (
    update public.conversation_state
       set last_read_at = now()
     where last_read_at > now()
     returning 1
  )
  select count(*) into n from fixed;
  if n > 0 then
    raise notice 'backfill: pulled % read receipt(s) back from the future', n;
  end if;

  if exists (select 1 from public.conversation_state where last_read_at > now()) then
    raise exception 'backfill did not land — a conversation still carries a future read receipt';
  end if;

  perform set_config('request.jwt.claims', '', true);
end $$;


-- ── Now prove the fix closes it, on the same staged shape ───────────────────
do $$
declare
  uid uuid; jid uuid; jid2 uuid; bid uuid; bid2 uuid;
  got timestamptz; pinned timestamptz; msg_at timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'read receipt probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'confirmed')
  returning id into bid;

  -- bookings is unique on (job_id, earner_id), so the second conversation needs a
  -- second job.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'read receipt probe 2', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, uid, 'confirmed')
  returning id into bid2;

  -- The counterparty's reply, 20 seconds after the read on the SERVER's clock — the
  -- message the fast-clock receipt used to swallow. Staged with an explicit created_at
  -- because the column default is now(), which is frozen for this transaction.
  insert into public.messages (booking_id, sender_id, text, created_at)
  values (bid, uid, 'reply that arrives after the read', now() + interval '20 seconds')
  returning created_at into msg_at;

  -- 1. The fast clock. The same INSERT that stored the year 2036 above must now store
  --    server time.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  insert into public.conversation_state (user_id, booking_id, last_read_at)
  values (uid, bid, now() + interval '10 years');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select last_read_at into got from public.conversation_state
   where user_id = uid and booking_id = bid;
  if got is distinct from now() then
    raise exception 'FIX FAILED: stored % rather than server time %', got, now();
  end if;
  raise notice 'discriminates: the same write that stored a 2036 receipt above now stores %', got;

  -- The consequence, stated the way the product reads it: a reply written after the
  -- read still sorts after the receipt, so isUnread still calls it unread.
  if msg_at <= got then
    raise exception
      'FIX FAILED: a reply sent at % still sorts at or before the receipt (%), so it is read on arrival', msg_at, got;
  end if;
  raise notice 'a reply at % now sorts after the receipt at %, so the badge fires', msg_at, got;

  -- 2. The slow clock. A backdated receipt must not leave a just-read thread badged.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.conversation_state set last_read_at = now() - interval '45 seconds'
   where user_id = uid and booking_id = bid;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select last_read_at into got from public.conversation_state
   where user_id = uid and booking_id = bid;
  if got is distinct from now() then
    raise exception
      'FIX FAILED: a backdated receipt was stored as %, so a thread the user just read stays badged', got;
  end if;
  raise notice 'a backdated receipt is taken as % instead, so the thread clears', got;
  pinned := got;

  -- 3. Not over-corrected: archiving must NOT be read as reading. This is the exact
  --    shape setConversationArchived sends — only `archived` in the SET list.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.conversation_state set archived = true
   where user_id = uid and booking_id = bid;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select last_read_at into got from public.conversation_state
   where user_id = uid and booking_id = bid;
  if got is distinct from pinned then
    raise exception
      'OVER-CORRECTED: archiving moved the read receipt from % to %, silently marking the conversation read', pinned, got;
  end if;
  if not (select archived from public.conversation_state where user_id = uid and booking_id = bid) then
    raise exception 'OVER-CORRECTED: the user can no longer archive their own conversation';
  end if;
  raise notice 'archiving still works and leaves the receipt at %', got;

  -- 4. A row created by the archive path carries no receipt, and must keep none —
  --    isUnread reads a missing receipt as unread, which is the correct default for a
  --    thread that has never been opened.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  insert into public.conversation_state (user_id, booking_id, archived)
  values (uid, bid2, true);

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select last_read_at into got from public.conversation_state
   where user_id = uid and booking_id = bid2;
  if got is not null then
    raise exception
      'OVER-CORRECTED: archiving an unopened conversation minted a read receipt (%)', got;
  end if;
  raise notice 'an archive-first row still has no receipt, so it stays unread';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'read receipt probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
