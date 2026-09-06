-- ─────────────────────────────────────────────────────────────────────────────
-- A reduced payout with no dispute row behind it, and nothing that could see it.
--
-- stripe-capture-payment does the irreversible thing first and the paperwork after.
-- The Stripe capture is at index.ts:331; downstream of it sit the payments update, two
-- fee RPCs, return_unused_fee_credit, credit_earnings, settle_booking_benefits and the
-- disputes insert — up to eight awaited round trips. Lose the instance anywhere in that
-- window (an SDK read timeout on the capture response, an edge deploy, an eviction) and
-- the money moved while none of the paperwork did: payment_intent.succeeded marks the
-- row 'captured' and credits the earner, and it writes NO disputes row.
--
-- The poster's retry then made it permanent rather than fixing it. Every consequence of
-- a capture hung off `capturedGigCents`, which was assigned ONLY inside the
-- `payment.status !== 'captured'` block — so on the retry the block was skipped, the
-- flag stayed null, and the function returned success with the paperwork still missing.
--
-- The EDGE FIX (same commit) re-derives what happened from the ledger on that retry:
-- earner_amount_cents + fee_cents against the immutable amount_cents. It deliberately
-- does not trust the caller's `pct`, because that gate exists to stop a poster POSTing
-- {pct: 0.5} at their own fully-settled booking and fabricating a dispute.
--
-- ── WHY A CONTROL AS WELL ────────────────────────────────────────────────────
-- The retry only repairs the record if the poster retries. If they give up, or if the
-- partial capture came from somewhere else entirely — the Stripe Dashboard, or
-- reconcileToStripe correcting a full capture downward because Stripe collected less
-- than we asked for — the earner was paid a reduced amount with no stated reason and
-- nothing in the database says so. Three separate consumers read that table and all
-- three go quiet: the console's /disputes queue, ctl_dispute_open_beyond_sla, and
-- earner-claim-payment's DISPUTE_OPEN gate.
--
-- ctl_payment_ledger_impossible is the nearest existing check and it cannot see this:
-- its captured-total test fires only when the split EXCEEDS the authorization. A
-- settlement that is legitimately SHORT is arithmetically fine and simply unexplained.
--
-- Two hours, matching ctl_benefit_never_settled: the dispute insert happens seconds
-- after the capture in the same invocation, so anything still missing at two hours is
-- missing because a code path ended, not because it is in flight.
--
-- Found by the money-edge-escrow audit pass, 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_partial_capture_without_dispute()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$
  select p.id::text as entity_id,
         jsonb_build_object(
           'booking_id', p.booking_id,
           'booking_status', b.status,
           'earner_id', b.earner_id,
           'poster_id', j.poster_id,
           'payment_intent_id', p.payment_intent_id,
           'authorized_cents', p.amount_cents,
           'captured_total_cents', p.earner_amount_cents + p.fee_cents,
           'released_to_poster_cents', p.amount_cents - (p.earner_amount_cents + p.fee_cents),
           'pct_settled', round(
             ((p.earner_amount_cents + p.fee_cents)::numeric / p.amount_cents) * 100, 1),
           'captured_at', p.captured_at,
           'note', 'this booking settled for LESS than the hold and carries no disputes '
                   'row. Every reduced payout is supposed to state a reason: '
                   'stripe-capture-payment inserts the row itself, so a gap here means '
                   'either the function died between the Stripe capture and its own '
                   'bookkeeping and nobody retried, or the partial capture came from '
                   'outside the app entirely (the Stripe Dashboard, or Stripe collecting '
                   'less than was asked for). The earner was paid short with no recorded '
                   'reason, and the /disputes queue, ctl_dispute_open_beyond_sla and '
                   'earner-claim-payment''s DISPUTE_OPEN gate are all blind to it.',
           'remedy', 'Read the PaymentIntent at Stripe and confirm what was actually '
                     'collected. If it was our own partial capture, ask the poster to '
                     'resubmit Verify & Rate at the same percentage with their reason — '
                     'the retry now re-derives the record from the ledger and files it. '
                     'If it was captured outside the app, record the reason on the '
                     'booking so the earner has one, and check whether the unused fee '
                     'credit on that booking was returned.'
         ) as detail
    from public.payments p
    join public.bookings b on b.id = p.booking_id
    join public.jobs j on j.id = b.job_id
   where p.status = 'captured'
     -- Both split columns must be populated: a legacy row captured before they existed
     -- would read as a 0c settlement and put every historical payment on the board.
     and p.earner_amount_cents is not null
     and p.fee_cents is not null
     and p.amount_cents > 0
     and p.earner_amount_cents + p.fee_cents > 0
     -- SHORT of the authorization. ctl_payment_ledger_impossible owns the other
     -- direction (a split that exceeds it), and that one is arithmetically impossible
     -- rather than merely unexplained.
     and p.earner_amount_cents + p.fee_cents < p.amount_cents
     and not exists (select 1 from public.disputes d where d.booking_id = p.booking_id)
     and coalesce(p.captured_at, b.created_at) < now() - interval '2 hours'
$ctl$;

revoke execute on function public.ctl_partial_capture_without_dispute() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('partial_capture_without_dispute',
   'Earner was paid less than the hold with no dispute record',
   'high', 'money',
   'A reduced payout must always carry a stated reason. stripe-capture-payment writes '
   'the disputes row itself, AFTER the irreversible Stripe capture and up to eight '
   'awaited round trips downstream of it — so an instance lost in that window leaves '
   'the money moved and the record missing. The retry now re-derives it from the '
   'ledger, but only if the poster retries; an externally-captured partial (Stripe '
   'Dashboard, or Stripe collecting less than requested) never had a retry to make. '
   'ctl_payment_ledger_impossible cannot see it: its captured-total test fires only '
   'when the split EXCEEDS the authorization, and a short settlement is arithmetically '
   'fine. Downstream, the /disputes queue, ctl_dispute_open_beyond_sla and '
   'earner-claim-payment''s DISPUTE_OPEN gate are all silent.',
   'ctl_partial_capture_without_dispute')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it discriminates, then roll everything back ────────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  n_new int; n_old int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'partial capture probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;

  -- A $100 hold settled at 50% with a 700 bps rate: 5000c collected, 350c fee,
  -- 4650c to the earner. Exactly what claimForCapture + the capture write.
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     status, captured_at)
  values (bid, 'pi_probe_' || replace(bid::text, '-', ''), 10000, 350, 4650,
          'captured', now())
  returning id into pid;

  -- Fresh: silent. A capture whose dispute insert is still in flight must not land on
  -- the board — that is how a control becomes noise nobody reads.
  select count(*) into n_new
    from public.ctl_partial_capture_without_dispute() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'fired on a capture from seconds ago — permanent noise (% rows)', n_new;
  end if;
  raise notice 'a just-captured payment is silent, so a normal partial capture never flickers on the board';

  -- Aged past the window with no dispute row: THE BROKEN STATE.
  update public.payments set captured_at = now() - interval '4 hours' where id = pid;
  select count(*) into n_new
    from public.ctl_partial_capture_without_dispute() where entity_id = pid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a 4-hour-old undocumented partial payout reported % rows', n_new;
  end if;

  -- THE DISCRIMINATION: the existing ledger control is blind to it. Its captured-total
  -- test fires only when the split EXCEEDS the authorization; short is legal.
  select count(*) into n_old
    from public.ctl_payment_ledger_impossible() where entity_id = pid::text;
  if n_old <> 0 then
    raise exception 'ctl_payment_ledger_impossible already covered this; the new control is redundant';
  end if;
  raise notice 'discriminates: new control sees it (% row), ctl_payment_ledger_impossible sees % — that gap is the finding', n_new, n_old;

  -- The dispute row arrives (the poster retried, or a human recorded it) ⇒ resolved.
  insert into public.disputes (booking_id, raised_by, reason, pct_paid)
  values (bid, uid, 'probe: work was incomplete', 50);
  select count(*) into n_new
    from public.ctl_partial_capture_without_dispute() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'still open after the dispute row exists — this finding could never auto-resolve';
  end if;
  raise notice 'filing the dispute row closes the finding, so it resolves rather than accumulating';

  -- And a FULL capture is the healthy outcome and must stay off the board, even with
  -- no dispute row — otherwise every settled booking on the platform lands here.
  delete from public.disputes where booking_id = bid;
  update public.payments
     set fee_cents = 700, earner_amount_cents = 9300 where id = pid;
  select count(*) into n_new
    from public.ctl_partial_capture_without_dispute() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'fired on a FULL capture, which is the healthy outcome (% rows)', n_new;
  end if;
  raise notice 'a full capture with no dispute row is healthy and stays off the board';

  if not exists (select 1 from public.controls
                  where key = 'partial_capture_without_dispute' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'partial-capture-without-dispute probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
