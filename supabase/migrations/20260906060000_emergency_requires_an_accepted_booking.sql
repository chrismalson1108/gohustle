-- ─────────────────────────────────────────────────────────────────────────────
-- The SOS button was an unbounded pager, reachable from a booking nobody accepted.
--
-- 20260806200000 exempted source='emergency' from the 10-reports-per-hour limiter and
-- 20260806290000 made that exemption order-independent. Both are RIGHT and neither is
-- disturbed here: a spam control must never be the reason someone in danger cannot
-- raise an alarm. But the exemption's whole premise is the sentence written beside it —
-- "an emergency raised from an active gig" — and raise_gig_emergency never enforced it.
--
-- Its only gate was `where bk.id = p_booking and (bk.earner_id = uid or j.poster_id =
-- uid)`. No status. No dedupe. And bookings_insert_own is a unilateral client write, so
-- ANY account can manufacture as many bookings as there are open gigs and then loop an
-- RPC that is granted to `authenticated`, exempt from the limiter, and wired to an
-- AFTER INSERT dispatcher. Each call:
--
--   • inserts an open report naming the counterparty,
--   • fires trg_notify_safety_report → safety-alert → one page to the on-call,
--   • lands in the Moderation queue as an 'emergency', and
--   • blocks that counterparty's account deletion (delete-account refuses on any open
--     non-auto report naming the user) until a trust-tier human resolves it.
--
-- ctl_emergency_flood notices at three per hour, but it is detect-only and hourly — it
-- is the record of the flood, not a bound on it. The client is not a bound either:
-- SafetyBar renders only on a started booking, and the RPC does not care what the
-- client renders.
--
-- ── TWO CHANGES, AND ONLY THE SECOND ONE BOUNDS THE FLOOD ───────────────────
--
-- 1. AN ACCEPTED BOOKING. status must be one of confirmed / completed / verified — the
--    same set job_locations_party_read (20260722040000) and gig_shares_insert_own
--    (20260806200000) already use for "these two people actually agreed to meet". It
--    excludes exactly the states that cost the attacker nothing: 'pending', which is a
--    unilateral write, and 'declined'/'cancelled', which are relationships the
--    counterparty refused or undid. On its own this only raises the price of an
--    eligible booking; one confirmed booking would still give an unbounded loop.
--
-- 2. ONE OPEN EMERGENCY PER PERSON PER GIG. A repeat press on a booking whose alarm is
--    still open returns the EXISTING report id instead of inserting a second one. That
--    is what turns "unbounded" into "one page per accepted booking": the alarm already
--    stands, a human is already looking at it, and a second identical row pages them
--    again to tell them nothing. Serialised on an advisory lock keyed to the pair, so
--    two concurrent presses cannot both read "none open" and both insert.
--
-- A genuine SOS is still never refused and still never counted: the FIRST emergency on
-- any accepted gig is always accepted, limiter-exempt, and paged immediately. What is
-- refused is a second alarm about a gig that is already alarming, and an alarm about a
-- gig that does not exist as an agreement.
--
-- A repeat press with NEW words is appended to the open report rather than discarded —
-- a person pressing SOS twice with something to add is the case where they are in more
-- trouble, and dropping their sentence on the floor would be a worse bug than the one
-- being fixed. It is appended once per distinct note and capped, so the client's fixed
-- string cannot grow the row. That path is an UPDATE, which trg_notify_safety_report
-- (AFTER INSERT, 20260715020000) does not dispatch on — the words reach the human
-- already holding the ticket, and no new page is sent.
--
-- No index is made UNIQUE here on purpose. A unique partial index would be the stronger
-- bound, but it cannot be created without first resolving whatever duplicate open
-- emergencies production already holds, and auto-resolving a real safety report to make
-- a migration apply is not a trade this repo takes.
-- ─────────────────────────────────────────────────────────────────────────────

-- Makes the dedupe lookup a single index probe rather than a scan of the queue.
create index if not exists reports_open_emergency_idx
  on public.reports (booking_id, reporter_id)
  where source = 'emergency' and resolved_at is null;

-- Reproduced from 20260806180000:281 with the status gate, the dedupe and the note
-- append added. Everything else — the party check, the app.emergency GUC, the
-- source='emergency' pin, the reported_user_id flip — is preserved exactly.
create or replace function public.raise_gig_emergency(p_booking uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid  uuid := auth.uid();
  b    record;
  rid  uuid;
  note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select bk.id, bk.earner_id, bk.job_id, bk.status, j.poster_id
    into b
    from public.bookings bk join public.jobs j on j.id = bk.job_id
   where bk.id = p_booking and (bk.earner_id = uid or j.poster_id = uid);
  if not found then raise exception 'not your booking'; end if;

  -- The premise the limiter exemption rests on, finally enforced. Same status set as
  -- job_locations_party_read: an agreement both parties are in, not an application one
  -- of them made.
  if b.status not in ('confirmed', 'completed', 'verified') then
    raise exception
      'This gig has not been accepted, so there is no active gig to raise an emergency on. If you are in danger, call your local emergency number now, then use Support to report a problem.'
      using errcode = 'check_violation';
  end if;

  -- Serialise the read-and-insert for this (gig, person) pair. Without it two presses a
  -- millisecond apart both see "no open emergency" and both page.
  perform pg_advisory_xact_lock(
    hashtextextended('gohustlr.sos:' || p_booking::text || ':' || uid::text, 0));

  -- Set BEFORE the update below as well as the insert: guard_reports_write rewrites
  -- source to 'user' on any non-service_role write that is not carrying this GUC, so
  -- appending a note without it would quietly demote a live emergency to a routine
  -- report and drop it out of the emergency queue.
  perform set_config('app.emergency', 'on', true);

  select r.id into rid
    from public.reports r
   where r.booking_id = p_booking
     and r.reporter_id = uid
     and r.source = 'emergency'
     and r.resolved_at is null
   order by r.created_at desc
   limit 1;

  if rid is not null then
    -- Keep new words, once each, capped. position(...) = 0 is what stops 500 presses of
    -- the client's fixed string from growing the row 500 times.
    if note is not null then
      update public.reports
         set details = left(
               coalesce(details, '')
               || E'\n[repeated ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI') || ' UTC] '
               || note, 4000)
       where id = rid
         and position(note in coalesce(details, '')) = 0;
    end if;
    return rid;
  end if;

  -- source='emergency' is what distinguishes this in the moderation queue from an
  -- ordinary report, and what the alert email leads with.
  insert into public.reports (reporter_id, reported_user_id, job_id, booking_id, reason, details, source)
  values (uid,
          case when uid = b.earner_id then b.poster_id else b.earner_id end,
          b.job_id, b.id, 'emergency',
          coalesce(note, 'Emergency raised from an active gig.'),
          'emergency')
  returning id into rid;

  return rid;
end;
$$;

revoke execute on function public.raise_gig_emergency(uuid, text) from public, anon;
grant execute on function public.raise_gig_emergency(uuid, text) to authenticated, service_role;

-- ── Prove it refuses an unaccepted gig and pages once per accepted one ──────
do $$
declare
  uid uuid; jid uuid; bid uuid;
  first_id uuid; second_id uuid;
  rows_after int;
  refused boolean := false;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- The pager itself is switched off for the duration. pg_net queues its request inside
  -- the transaction and this whole block rolls back, so nothing would be sent anyway —
  -- but a probe that could page the on-call is not a probe worth running.
  update public.app_flags set enabled = false where key = 'safety_alert';

  -- 'cancelled', like the other probes in this directory: a staged job must never be
  -- browsable, even for the moments before the rollback.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'sos probe', 'Odd Jobs', 50, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'pending')
  returning id into bid;

  -- Speak as the user from here: auth.uid() reads the JWT claim, and the whole point is
  -- what an ordinary authenticated caller can do.
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  -- 1. A PENDING booking — a unilateral application — must be refused. Under the old
  --    definition this returned a report id and paged the on-call.
  begin
    perform public.raise_gig_emergency(bid, 'probe on a pending booking');
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'FIX FAILED: an emergency was accepted on a pending booking';
  end if;
  if exists (select 1 from public.reports where booking_id = bid) then
    raise exception 'FIX FAILED: the refused call still wrote a report';
  end if;
  raise notice 'discriminates: pending booking refused, 0 reports written (old code: 1 report + 1 page)';

  -- 2. Accept it, and the FIRST emergency goes through untouched.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.bookings set status = 'confirmed' where id = bid;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  first_id := public.raise_gig_emergency(bid, 'probe first press');
  if first_id is null then
    raise exception 'FIX FAILED: a genuine SOS on a confirmed booking was refused';
  end if;
  if not exists (select 1 from public.reports where id = first_id and source = 'emergency') then
    raise exception 'FIX FAILED: the emergency did not land as source=emergency';
  end if;

  -- 3. A second press returns the SAME open report instead of paging again.
  second_id := public.raise_gig_emergency(bid, 'probe second press with new words');
  if second_id is distinct from first_id then
    raise exception 'FIX FAILED: a repeat press minted a second emergency (% then %)', first_id, second_id;
  end if;
  select count(*) into rows_after from public.reports where booking_id = bid;
  if rows_after <> 1 then
    raise exception 'FIX FAILED: % report rows after two presses, expected 1', rows_after;
  end if;
  if (select position('probe second press with new words' in coalesce(details, ''))
        from public.reports where id = first_id) = 0 then
    raise exception 'FIX FAILED: the repeat press lost its note';
  end if;
  if (select source from public.reports where id = first_id) <> 'emergency' then
    raise exception 'FIX FAILED: the note append demoted the report out of the emergency queue';
  end if;
  raise notice 'two presses, one report, one page — and the second note was kept';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'SOS probe passed; all staged rows and the flag change rolled back';
  else
    raise;
  end if;
end $$;
