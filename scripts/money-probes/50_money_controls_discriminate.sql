-- Do the critical money controls actually DISCRIMINATE?
--
-- A control that cannot fire is worse than no control: the board shows green and the
-- operator stops looking. For each, stage the violating row, assert it fires, repair the
-- row, assert it clears. Rolled back.
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; pay_id uuid; did uuid;
  n int; msg text := '';
  procedure_note text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Controls probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;

  -- ── ctl_earner_credit_missing (CRITICAL) ────────────────────────────────
  -- Money captured from a poster but never credited to the earner's ledger.
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at,
                               captured_at, earnings_credited)
  values (bid, 10000, 700, 9300, 'captured', 'pi_probe_controls',
          now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', false)
  returning id into pay_id;
  select count(*) into n from public.ctl_earner_credit_missing() where entity_id = pay_id::text;
  msg := msg || format(E'\n  earner_credit_missing: uncredited capture -> fires %s (expect 1)', n);
  update public.payments set earnings_credited = true where id = pay_id;
  select count(*) into n from public.ctl_earner_credit_missing() where entity_id = pay_id::text;
  msg := msg || format(E'  | credited -> %s (expect 0)', n);

  -- ── ctl_payment_ledger_impossible (CRITICAL) ────────────────────────────
  -- refunded_cents > amount_cents is prevented by payments_refunded_cents_check, so the
  -- SCHEMA already owns that shape. Use the one it does not: a split that collects more
  -- than was ever authorized.
  begin
    update public.payments set earner_amount_cents = 99000, fee_cents = 5000 where id = pay_id;
    select count(*) into n from public.ctl_payment_ledger_impossible() where entity_id = pay_id::text;
    msg := msg || format(E'\n  payment_ledger_impossible: split 104000 on a 10000 hold -> fires %s (expect 1)', n);
    update public.payments set earner_amount_cents = 9300, fee_cents = 700 where id = pay_id;
    select count(*) into n from public.ctl_payment_ledger_impossible() where entity_id = pay_id::text;
    msg := msg || format(E'  | repaired -> %s (expect 0)', n);
  exception when others then
    msg := msg || format(E'\n  payment_ledger_impossible: SCHEMA PREVENTS the staging (%s)', sqlerrm);
  end;

  -- ── ctl_partial_capture_without_dispute (HIGH) ──────────────────────────
  -- Earner paid less than the hold with no dispute record behind it.
  update public.payments set earner_amount_cents = 4650, fee_cents = 350 where id = pay_id;
  select count(*) into n from public.ctl_partial_capture_without_dispute() where entity_id = pay_id::text;
  msg := msg || format(E'\n  partial_capture_without_dispute: 5000 of 10000, no dispute -> fires %s (expect 1)', n);
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, pct_paid,
                               settled_at, resolved_at, status)
  values (bid, poster, 'probe', 50, 50, now(), now(), 'resolved') returning id into did;
  select count(*) into n from public.ctl_partial_capture_without_dispute() where entity_id = pay_id::text;
  msg := msg || format(E'  | with the dispute row -> %s (expect 0)', n);

  -- ── ctl_settled_without_captured_payment (CRITICAL) ─────────────────────
  -- A booking claiming settlement with no captured payment behind it.
  update public.payments set status = 'authorized', captured_at = null where id = pay_id;
  update public.bookings set status = 'verified' where id = bid;
  select count(*) into n from public.ctl_settled_without_captured_payment() where entity_id = bid::text;
  msg := msg || format(E'\n  settled_without_captured_payment: verified on an uncaptured hold -> fires %s (expect 1)', n);
  update public.payments set status = 'captured', captured_at = now() where id = pay_id;
  select count(*) into n from public.ctl_settled_without_captured_payment() where entity_id = bid::text;
  msg := msg || format(E'  | captured -> %s (expect 0)', n);

  -- ── ctl_dispute_settlement_overdue (CRITICAL) ───────────────────────────
  -- A dispute that is due to be paid and has not been.
  update public.payments set status = 'authorized', captured_at = null where id = pay_id;
  update public.bookings set status = 'completed' where id = bid;
  update public.disputes set pct_paid = null, settled_at = null, resolved_at = null,
         status = 'open', settle_after = now() - interval '6 hours' where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  msg := msg || format(E'\n  dispute_settlement_overdue: due 6h ago, unpaid -> fires %s (expect 1)', n);
  update public.disputes set pct_paid = 100, settled_at = now(), resolved_at = now(),
         status = 'rejected' where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  msg := msg || format(E'  | settled -> %s (expect 0)', n);

  -- ── ctl_escrow_hold_lapsed_uncancelled (CRITICAL) ───────────────────────
  update public.payments set status = 'authorized', captured_at = null,
         authorized_at = now() - interval '9 days', created_at = now() - interval '9 days'
   where id = pay_id;
  select count(*) into n from public.ctl_escrow_hold_lapsed_uncancelled() where entity_id = pay_id::text;
  msg := msg || format(E'\n  escrow_hold_lapsed_uncancelled: 9-day-old live hold -> fires %s (expect 1)', n);
  update public.payments set authorized_at = now(), created_at = now() where id = pay_id;
  select count(*) into n from public.ctl_escrow_hold_lapsed_uncancelled() where entity_id = pay_id::text;
  msg := msg || format(E'  | fresh -> %s (expect 0)', n);

  raise exception E'MONEY CONTROLS PROBE (rolled back):%', msg;
end $$;
