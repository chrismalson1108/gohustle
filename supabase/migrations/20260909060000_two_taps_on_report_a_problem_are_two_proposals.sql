-- Two defects in the day-old two-party dispute model, both found by auditing it.
--
-- ── 1. Nothing stops a booking carrying two LIVE proposals ──────────────────
--
-- stripe-capture-payment guards its proposal insert by SELECTing first
-- (index.ts:183-186) and inserting if it saw nothing. That is read-then-decide, the
-- exact shape this repo forbids everywhere else it handles money: "the increment IS
-- the check", "the unique index IS the idempotency check". `disputes` has no unique
-- index at all beyond its primary key, so the only thing between a double-tapped
-- "report a problem" — or a client retry on a slow response — and two proposals is a
-- race the code loses.
--
-- Two live proposals is not a cosmetic duplicate. Each one arms its own clock in
-- dispute_set_defaults and each one fires dispute_notify_respondent, so the earner is
-- told twice, with two different percentages and two different deadlines, about one
-- gig. settle-disputes then lists both, settles the first, and stamps the second with
-- whatever the FIRST one collected — because settleEscrow finds the payment already
-- captured and re-derives settledPct from the ledger. The second row's own
-- proposed_pct is never honoured and never refused; it is silently overwritten.
--
-- The guard's read is `.maybeSingle()`, which does not merely race — it ERRORS the
-- moment a booking legitimately holds two dispute rows, and a booking can:
-- NO_ROOM_TO_HOLD files a pre-settled row (pct_paid = 100), and stripe-webhook's
-- recordReversal files a bare refund/chargeback row. supabase-js returns
-- {data: null, error} for >1 row, the code destructures only `data`, and so the
-- "already proposed" branch is skipped and a THIRD row is inserted.
--
-- The index is PARTIAL on exactly what must be unique: a live adjustment.
--   * pct_paid is not null  -> settled, including the NO_ROOM_TO_HOLD record
--   * proposed_pct is null  -> a reversal record, which accuses nobody
-- Both stay allowed alongside a live proposal, which is why 20260909050000's own
-- probe (a pre-settled row and a live proposal on one booking) still passes.
--
-- MEASURED AGAINST PRODUCTION, 2026-09-08, in a rolled-back transaction: staged a
-- pre-settled row, a reversal record and a live proposal on ONE booking, then inserted a
-- SECOND live proposal at a different percentage. It was accepted — four dispute rows on
-- one booking, two of them live and contradicting each other. That is the BROKEN half of
-- the discrimination proof; the probe at the bottom of this file is the fixed half.
--
-- ── 2. The poster is told a human will look, and branch 4 breaks that ───────
--
-- When the earner contests, respond_to_dispute writes the POSTER a durable inbox row
-- reading "Nothing is paid until we do." dispute_settlement_pct branch 4 captures
-- 100% once the authorization nears expiry with nobody having adjudicated — by
-- design, because a partial capture cannot be topped up and a full one can be
-- refunded. Both CLIENTS were corrected for this (DisputeScreen.js:233-234 and the
-- web twin both say "if we have not decided before the card hold runs out, you are
-- paid in FULL"). The server-authored notice to the party who actually PAYS was not.
--
-- So the one person whose card is charged the full amount without review is the one
-- promised a review first, in writing, in a message they keep.

create unique index if not exists disputes_one_live_proposal_per_booking
  on public.disputes (booking_id)
  where pct_paid is null and proposed_pct is not null;

comment on index public.disputes_one_live_proposal_per_booking is
  'One live adjustment proposal per booking. Settled rows (pct_paid) and reversal '
  'records (no proposed_pct) are deliberately outside it. This index — not the '
  'SELECT in stripe-capture-payment — is the idempotency check.';

-- Unchanged from 20260909010000 apart from the contest notification body.
create or replace function public.respond_to_dispute(
  p_dispute_id uuid,
  p_stance text,
  p_note text default null,
  p_photos text[] default '{}'
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d public.disputes;
  clean_photos text[];
begin
  if p_stance not in ('accept', 'contest') then
    raise exception 'stance must be accept or contest' using errcode = 'check_violation';
  end if;

  select * into d from public.disputes where id = p_dispute_id;
  if not found then
    raise exception 'dispute not found' using errcode = 'no_data_found';
  end if;
  -- Only the accused, and only while it is still open. Not the raiser: they had
  -- their say when they proposed.
  if d.respondent_id is distinct from auth.uid() then
    raise exception 'not your dispute' using errcode = 'insufficient_privilege';
  end if;
  if d.responded_at is not null then
    raise exception 'you have already responded to this' using errcode = 'check_violation';
  end if;
  if d.pct_paid is not null then
    raise exception 'this has already been settled' using errcode = 'check_violation';
  end if;

  -- Same rule the poster's photos get: only the caller's own storage prefix. A
  -- respondent who could name any path would pull another user's private photos into
  -- a record support reads.
  clean_photos := coalesce((
    select array_agg(p) from unnest(coalesce(p_photos, '{}')) p
     where p like auth.uid()::text || '/%'
     limit 6
  ), '{}');

  perform set_config('app.dispute_response', p_dispute_id::text, true);

  update public.disputes
     set responded_at    = now(),
         response_stance = p_stance,
         response_note   = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
         response_photos = clean_photos,
         -- 'investigating' is the EXISTING enum value for contested, deliberately —
         -- see the header. vest_bonuses already treats it as unresolved.
         status          = case when p_stance = 'contest' then 'investigating' else status end,
         -- Accepting settles at the next sweep rather than waiting out the clock.
         settle_after    = case when p_stance = 'accept' then now() else settle_after end
   where id = p_dispute_id;

  -- Tell the RAISER their counterparty answered, so a contest is not something they
  -- have to go looking for.
  --
  -- The contest line names the auto-capture. It used to end "Nothing is paid until we
  -- do", which is true only while we get to it in time: branch 4 of
  -- dispute_settlement_pct captures the FULL amount once the authorization nears
  -- expiry and nobody has adjudicated. Both clients already say so to the earner; the
  -- poster is the one whose card it is.
  insert into public.notifications (user_id, type, title, body, job_id, data)
  select d.raised_by,
         'dispute',
         case when p_stance = 'accept' then 'They accepted your adjustment' else 'They disputed your report' end,
         case when p_stance = 'accept'
              then 'The worker accepted ' || coalesce(d.proposed_pct, 100)::text || '%. It will be paid shortly.'
              else 'The worker has responded and asked us to look at it. Nothing is paid while we do — '
                   || 'but if we have not decided before the card hold runs out, the full amount is '
                   || 'charged and paid to them.' end,
         j.id,
         jsonb_build_object('dispute_id', d.id, 'booking_id', d.booking_id)
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = d.booking_id;

  return true;
end;
$function$;

-- ── Probe: both halves, proved to discriminate, then rolled back ────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; d_live uuid; d_settled uuid;
  dupe_blocked boolean := false;
  body_text text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 060000', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_060000', now(), now());

  -- A settled row and a reversal row must BOTH remain allowed beside a live proposal,
  -- or this index breaks NO_ROOM_TO_HOLD and recordReversal.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, pct_paid,
                               settled_at, resolved_at, status)
  values (bid, poster, 'no runway', 75, 100, now(), now(), 'rejected') returning id into d_settled;
  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'Stripe refund on charge ch_probe (usd 5.00 refunded)');

  -- The live proposal.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'first report', 75) returning id into d_live;

  -- The SECOND live proposal is what the double tap produces. It must be refused.
  begin
    insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
    values (bid, poster, 'second report', 50);
  exception when unique_violation then
    dupe_blocked := true;
  end;
  if not dupe_blocked then
    raise exception 'FIX FAILED: a booking still accepts two live adjustment proposals';
  end if;
  if (select count(*) from public.disputes where booking_id = bid) <> 3 then
    raise exception 'FIX FAILED: the index took a row it should have left alone (settled/reversal)';
  end if;

  -- The earner answers, contesting. The poster's notice must name the auto-capture.
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  perform public.respond_to_dispute(d_live, 'contest', 'I did the work', '{}');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select body into body_text from public.notifications
   where user_id = poster and data->>'dispute_id' = d_live::text
   order by created_at desc limit 1;
  if body_text is null then
    raise exception 'FIX FAILED: the raiser was never told their counterparty answered';
  end if;
  if body_text like '%until we do%' or body_text not like '%card hold runs out%' then
    raise exception 'FIX FAILED: the poster is still promised a review branch 4 does not give: %', body_text;
  end if;

  raise notice 'probe: one live proposal per booking, and the poster is told about the auto-capture';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
