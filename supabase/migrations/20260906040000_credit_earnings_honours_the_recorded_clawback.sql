-- ─────────────────────────────────────────────────────────────────────────────
-- A refund recorded before the credit landed was recorded and then never taken, and the
-- remedy that followed credited the GROSS.
--
-- record_refund (final: 20260814130000:97-117) computes the earner's share of a reversal
-- and writes it to payments.earner_refunded_cents UNCONDITIONALLY, then calls
-- debit_earnings and DISCARDS the boolean. debit_earnings (final: 20260804020000:44-46)
-- returns false without touching profiles when earnings_credited is false — deliberately,
-- since debiting an earner for money they were never credited would be the worse bug.
--
-- So on a capture whose credit failed — the exact state ctl_earner_credit_missing exists
-- for, and which stripe-capture-payment, the webhook and admin-payment-action can all
-- leave behind — a refund records a clawback of X that nothing applied. Then the remedy
-- (`select public.credit_earnings(<id>)`, or a late payment_intent.succeeded webhook at
-- stripe-webhook/index.ts:329) credited earner_amount_cents IN FULL, with no regard for
-- the X already recorded against the row.
--
--   $60 captured (earner 5580 / fee 420), credit_earnings failed. The console refunds $30
--   with reverse_transfer:true — Stripe genuinely pulls 2790 back out of the earner's
--   Connect account. record_refund writes earner_refunded_cents = 2790 and debits nothing.
--   The operator then runs the remedy and profiles.earnings_total moves by +55.80.
--   The earner's real position is 27.90. Their dashboard says 55.80, permanently.
--
-- Three things break at once, and all three are already-built machinery reporting a
-- number it was told to trust:
--   • ctl_earnings_total_drift's `clawed` CTE reads earner_refunded_cents and requires
--     earnings_credited, so it is silent at refund time and opens a HIGH the moment the
--     remedy lands — on a real earner, with nothing able to auto-resolve it.
--   • src/lib/payments.js:118 READS the column, so Transactions shows the earner
--     "Your share of the refund − $27.90" beside a balance that never lost it.
--   • 20260814050000's stated contract — earner_refunded_cents "records what
--     debit_earnings ACTUALLY took" — is false for exactly this row.
--
-- ── WHY NET THE CREDIT RATHER THAN RECORD ZERO ──────────────────────────────
-- The other repair is to have record_refund keep debit_earnings' return value and record
-- 0 when it refused. That restores the letter of the contract and loses the money: the
-- reversal really did happen at Stripe, so a clawback dropped on the floor leaves the
-- earner's in-app balance overstated just the same, with nothing left on the row to say
-- so. The recorded figure is the only durable memory of the reversal, and it must be
-- HONOURED, not deleted.
--
-- credit_earnings is the one place that can honour it, because it is the one place that
-- runs after a deferred clawback and before the money is claimed. It now credits
--     earner_amount_cents − earner_refunded_cents
-- floored at 0, read in the SAME conditional claim UPDATE's RETURNING so the figure comes
-- from under the row lock record_refund also takes (`for update`). Whichever of the two
-- commits first, the other sees the settled value: credit-then-refund debits normally,
-- refund-then-credit withholds. The clawback is applied exactly once either way, because
-- credit_earnings' claim can only ever fire once per payment.
--
-- The contract sharpens rather than changing: earner_refunded_cents is what came off the
-- earner's in-app balance, whether debit_earnings took it or the credit withheld it. It
-- stays 0 on a lost chargeback, where nothing was taken (20260813160000 — the platform
-- absorbs a destination-charge reversal).
--
-- Everything downstream then reconciles with no further change: ctl_earnings_total_drift
-- expects credited_gross − recorded_clawback, which is what the balance now holds, and
-- the receipt line the client already renders describes money the earner actually lost.
--
-- Found by the money-db-pinning audit pass, reproduced against current code 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.credit_earnings(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount  integer;
  v_clawed  integer;
  v_net     integer;
  v_earner  uuid;
  v_dollars numeric;
begin
  -- The claim is unchanged and still exactly-once: only the call that flips
  -- earnings_credited false->true proceeds, so a concurrent capture and webhook credit
  -- once between them. What is new is that the RETURNING also carries the clawback
  -- already recorded against this row, read under the same lock rather than in a second
  -- statement a refund could slip between.
  update public.payments
     set earnings_credited = true
   where id = p_payment_id
     and coalesce(earnings_credited, false) = false
     and status = 'captured'
     and coalesce(earner_amount_cents, 0) > 0
   returning coalesce(earner_amount_cents, 0), coalesce(earner_refunded_cents, 0)
        into v_amount, v_clawed;

  if v_amount is null then
    return false;  -- already credited, not captured, or nothing to credit
  end if;

  select b.earner_id into v_earner
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.id = p_payment_id;

  if v_earner is null then
    return false;
  end if;

  -- What this credit is actually worth to the earner. A reversal recorded before the
  -- credit landed was never taken off them — debit_earnings refuses on an uncredited
  -- payment — so it is withheld here instead. Floored at 0: record_refund rounds the
  -- share per call and caps only the CAPTURE total, so a pathological run of partials can
  -- sum a cent past earner_amount_cents, and a negative credit would be a silent debit
  -- against unrelated earnings.
  v_net := greatest(0, v_amount - coalesce(v_clawed, 0));

  -- Reset a stale day/week bucket first, otherwise the increment below compounds onto a
  -- figure from a previous day/week and "today"/"this week" never go down. Unconditional,
  -- including on a fully reversed capture: the buckets are wrong whether or not this call
  -- adds to them.
  perform public.roll_earnings_period(v_earner);

  if v_net > 0 then
    v_dollars := v_net::numeric / 100;
    update public.profiles
       set earnings_today = coalesce(earnings_today, 0) + v_dollars,
           earnings_week  = coalesce(earnings_week,  0) + v_dollars,
           earnings_total = coalesce(earnings_total, 0) + v_dollars
     where id = v_earner;
  end if;

  -- TRUE means "this call claimed the credit", which is what every caller treats it as.
  -- A capture reversed down to nothing is still credited — leaving the flag false would
  -- park the row in ctl_earner_credit_missing forever with a remedy that can never move
  -- a number.
  return true;
end;
$$;

-- `create or replace` preserves the ACL, but re-assert it so a rebuilt DB lands in the
-- same state (20260702000000 / 20260702040000 / 20260722010000).
revoke execute on function public.credit_earnings(uuid) from public, anon, authenticated;
grant execute on function public.credit_earnings(uuid) to service_role;

comment on column public.payments.earner_refunded_cents is
  'Cents removed from the earner''s in-app balance on account of reversals of this '
  'payment, summed across refunds. Taken by debit_earnings when the capture was already '
  'credited, and WITHHELD by credit_earnings when the refund arrived first — a deferred '
  'clawback is honoured, never dropped. 0 on a lost chargeback (the platform absorbs it). '
  'Recorded, never recomputed — the proportional formula is wrong on the chargeback path '
  'and drifts under partial refunds.';

-- ── Blast radius: the control that describes this state said the opposite ────
-- ctl_earner_credit_missing's registry entry (20260806040000:621) told the operator that
-- "a later refund is silently forgiven ... so the platform eats it". That was true of the
-- code as written and is now false, and false in the dangerous direction: an operator who
-- believes a refund on an uncredited capture costs nothing has no reason to check the
-- balance afterwards. Surgical replace rather than a retyped 2000-character string, so
-- nothing else in the entry can drift while correcting one clause.
update public.controls
   set why = replace(
     why,
     'and a later refund is silently forgiven because debit_earnings refuses to debit a '
     'payment whose earnings_credited is false (20260804020000:45-47), so the platform '
     'eats it.',
     'and a refund arriving before the remedy is DEFERRED rather than forgiven: '
     'debit_earnings still refuses to debit an uncredited payment, but record_refund has '
     'recorded the share on payments.earner_refunded_cents and credit_earnings withholds '
     'it when the credit finally lands (20260906040000), so the remedy below settles the '
     'earner at their true net rather than the gross.')
 where key = 'earner_credit_missing';


-- ── Prove it discriminates: same staged row, deferred clawback vs gross credit ──
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  jid2 uuid; bid2 uuid; pid2 uuid;
  e0 numeric; e1 numeric; e2 numeric; e3 numeric;
  v_recorded int; v_ok boolean; n int; clean boolean := true;
  v_why text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A profile with NO payments and NO tips, so the drift control's expectation for them
  -- is exactly what this probe stages. `deleted_at is null` is load-bearing: a tombstoned
  -- profile's guard refuses the seeding UPDATE, and the probe then fails as "not
  -- discriminating", which is a true statement about the wrong cause (20260814010000).
  select p.id into uid
    from public.profiles p
   where p.deleted_at is null
     and not exists (select 1 from public.bookings b
                      join public.payments pay on pay.booking_id = b.id
                     where b.earner_id = p.id)
     and not exists (select 1 from public.tip_ledger t where t.earner_id = p.id)
   limit 1;

  if uid is null then
    -- Fall back to any live profile. Every assertion below still holds except the one
    -- about the drift control, whose expectation would then include their real history.
    clean := false;
    select id into uid from public.profiles where deleted_at is null limit 1;
  end if;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  update public.profiles set earnings_total = 0, earnings_week = 0, earnings_today = 0
   where id = uid;
  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  if e0 <> 0 then
    raise exception 'could not zero the balance on profile % (guard refused the write?) — probe cannot discriminate', uid;
  end if;

  -- ── The state this is all about: captured at Stripe, credit never landed ──
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'deferred clawback probe', 'Odd Jobs', 60, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited, fee_bps)
  values (bid, 'pi_deferred_clawback_probe', 6000, 420, 5580, 0, 'captured',
          now() - interval '30 minutes', false, 700)
  returning id into pid;

  -- It is the shape the escrow arm of ctl_earner_credit_missing was built to surface.
  select count(*) into n from public.ctl_earner_credit_missing() where entity_id = pid::text;
  if n <> 1 then
    raise exception 'staging wrong: ctl_earner_credit_missing does not see the uncredited capture (% rows)', n;
  end if;
  raise notice 'staged the uncredited capture the escrow control exists for';

  -- ── A $30 refund lands BEFORE the remedy. Stripe pulls 2790 out of the Connect
  --    account; debit_earnings refuses, because nothing was ever credited. ──
  perform public.record_refund(pid, 3000, 'deferred clawback probe', uid, true, 're_deferred_probe_AAA');
  select coalesce(earner_refunded_cents, 0) into v_recorded from public.payments where id = pid;
  select coalesce(earnings_total, 0) into e1 from public.profiles where id = uid;

  if v_recorded <> 2790 then
    raise exception 'staging wrong: expected a recorded clawback of 2790, got %', v_recorded;
  end if;
  if e1 <> 0 then
    raise exception 'staging wrong: debit_earnings moved the balance (% -> %) on an UNCREDITED capture', e0, e1;
  end if;
  raise notice 'the clawback is RECORDED (%c) and nothing was taken — the deferred state', v_recorded;

  -- ── The remedy the control tells the operator to run. ──
  v_ok := public.credit_earnings(pid);
  select coalesce(earnings_total, 0) into e2 from public.profiles where id = uid;

  if not v_ok then
    raise exception 'credit_earnings refused a captured, uncredited payment';
  end if;

  -- THE DISCRIMINATION. The old body credited earner_amount_cents in full: 55.80 on this
  -- row, against a true position of 27.90. The two figures differ by the whole clawback,
  -- so this row cannot pass under both versions.
  if e2 = 55.80 then
    raise exception 'FIX ABSENT: credited the GROSS 55.80 over a recorded 27.90 clawback — the earner is overstated by exactly what Stripe took back';
  end if;
  if e2 <> 27.90 then
    raise exception 'FIX WRONG: expected earnings_total 27.90 (5580 - 2790), got %', e2;
  end if;
  raise notice 'discriminates: the credit landed NET at % — the old body would have written 55.80', e2;

  -- And the drift control, which reads the same recorded figure, is satisfied. Before this
  -- fix it opened a permanent HIGH here that nothing could auto-resolve.
  if clean then
    select count(*) into n from public.ctl_earnings_total_drift() where entity_id = uid::text;
    if n <> 0 then
      raise exception 'ctl_earnings_total_drift still reports drift for this earner (% rows) — the balance and the ledger disagree', n;
    end if;
    raise notice 'ctl_earnings_total_drift is silent: the stored balance now equals credited gross minus the recorded clawback';
  else
    raise notice 'no payment-free profile available; skipped the drift assertion (their real history is in the expectation)';
  end if;

  -- ── The ordinary path is untouched: no clawback recorded, credit the gross. ──
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'unrefunded control probe', 'Odd Jobs', 60, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, uid, 'verified')
  returning id into bid2;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, earnings_credited, fee_bps)
  values (bid2, 'pi_unrefunded_control_probe', 6000, 420, 5580, 0, 'captured', now(), false, 700)
  returning id into pid2;

  perform public.credit_earnings(pid2);
  select coalesce(earnings_total, 0) into e3 from public.profiles where id = uid;
  if e3 - e2 <> 55.80 then
    raise exception 'OVER-CORRECTED: an unrefunded capture credited % instead of 55.80', e3 - e2;
  end if;
  raise notice 'an unrefunded capture still credits the full 55.80, so the ordinary path is unchanged';

  -- Second call on the same payment is still a no-op — the claim, not the amount, is what
  -- makes this exactly-once, and netting must not have introduced a second increment.
  if public.credit_earnings(pid2) then
    raise exception 'credit_earnings claimed the same payment twice';
  end if;
  select coalesce(earnings_total, 0) into e3 from public.profiles where id = uid;
  if e3 - e2 <> 55.80 then
    raise exception 'DOUBLE CREDIT: a repeat call moved the balance to %', e3;
  end if;
  raise notice 'a repeat call credits nothing, so capture and webhook still credit once between them';

  -- The operator-facing sentence no longer says the refund was forgiven.
  select why into v_why from public.controls where key = 'earner_credit_missing';
  if v_why is null then
    raise exception 'earner_credit_missing is not registered — run_all_controls would never call it';
  end if;
  if position('silently forgiven' in v_why) > 0 then
    raise exception 'the control still tells the operator a refund here is silently forgiven';
  end if;
  if position('DEFERRED rather than forgiven' in v_why) = 0 then
    raise exception 'the control entry was not corrected — the clause it replaces may have drifted';
  end if;
  raise notice 'the control now describes a deferred clawback rather than a forgiven one';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'deferred clawback probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
