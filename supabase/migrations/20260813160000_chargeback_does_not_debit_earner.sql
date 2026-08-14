-- ─────────────────────────────────────────────────────────────────────────────
-- A chargeback debited the earner's ledger for money nobody took back from them.
--
-- record_refund ends with an unconditional `debit_earnings(payment_id, earner_share)`.
-- Two very different operations call it:
--
--   refund      admin-payment-action passes `reverse_transfer: true, refund_application_fee: true`
--               to Stripe. The earner's money is genuinely pulled back out of their
--               connected account. The debit is EARNED, and its own comment says so:
--               "pull it back from the connected account rather than eating it on the
--               platform balance."
--
--   chargeback  record_reversal makes NO stripe.* call at all. On a destination charge
--               Stripe debits the PLATFORM balance and does not reverse the transfer, so
--               the money is already with the earner and stays there.
--
-- On the second path the debit recovers nothing. debit_earnings does
-- `greatest(0, earnings_* - dollars)` on today/week/total — no debt row, no clawback, no
-- withholding. It just makes the earner's displayed earnings smaller than what they were
-- actually paid, silently, for something the POSTER's cardholder did.
--
-- ── THE DECISION ────────────────────────────────────────────────────────────
--
-- The platform absorbs chargebacks. Stop debiting the earner on that path.
--
-- Three reasons, in order of weight:
--   1. It recovers nothing. It is a cosmetic decrement that makes a number wrong.
--   2. The earner did the work. A chargeback is a dispute between the poster and their
--      card issuer, and the earner has no notice, no evidence to submit, and no appeal.
--   3. RUNBOOK_MONEY:78 already states "the platform eats it". The runbook and the code
--      disagreed; the runbook is the considered position and the code was an accident of
--      sharing one function between two unlike operations.
--
-- If earner liability is ever wanted, it needs a real mechanism — a debt row, withholding
-- against future payouts, notification, an appeal path. Not a silent subtraction. Today's
-- behaviour is the worst of both: the earner keeps the cash AND loses the record of it.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the 4-arg form first. Adding a 5-arg overload WITH a default alongside it makes
-- record_refund(uuid,integer,text,uuid) ambiguous and every existing caller starts
-- failing with "function is not unique" — the exact trap hit earlier today on
-- promo_benefit_cents.
drop function if exists public.record_refund(uuid, integer, text, uuid);

create or replace function public.record_refund(
  p_payment_id  uuid,
  p_cents       integer,
  p_reason      text,
  p_admin       uuid,
  -- Default TRUE so the refund path — the one that actually claws the money back — keeps
  -- its existing behaviour without touching its call site.
  p_debit_earner boolean default true
) returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_captured integer;
  v_already  integer;
  v_earner_share integer;
  v_new      integer;
begin
  -- FOR UPDATE serialises concurrent refunds on this payment.
  select coalesce(earner_amount_cents, 0) + coalesce(fee_cents, 0), coalesce(refunded_cents, 0)
    into v_captured, v_already
    from public.payments
   where id = p_payment_id
   for update;

  if v_captured is null then
    return null;
  end if;
  if v_already + p_cents > v_captured then
    return null;  -- caller reports "only N remains refundable"
  end if;

  v_new := v_already + p_cents;
  update public.payments
     set refunded_cents = v_new,
         refunded_at    = now(),
         refund_reason  = p_reason,
         refunded_by    = p_admin
   where id = p_payment_id;

  -- ONLY when the money was actually recovered from the earner. See the header: a
  -- chargeback on a destination charge hits the platform balance and leaves the
  -- transfer alone, so there is nothing to debit and debiting anyway only falsifies
  -- the earner's own record of what they were paid.
  if p_debit_earner then
    select round(p_cents::numeric * coalesce(earner_amount_cents, 0) / nullif(v_captured, 0))::integer
      into v_earner_share
      from public.payments where id = p_payment_id;

    perform public.debit_earnings(p_payment_id, v_earner_share);
  end if;

  return v_new;
end;
$function$;

revoke execute on function public.record_refund(uuid, integer, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, integer, text, uuid, boolean) to service_role;

-- ── Prove both paths, on a staged row, rolled back ─────────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  before_total numeric; after_cb numeric; after_refund numeric;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;

  insert into public.jobs (poster_id,title,category,pay,pay_type,location,description,status)
  values (uid,'chargeback probe','Odd Jobs',100,'flat','P','p','cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified') returning id into bid;
  insert into public.payments (booking_id,payment_intent_id,amount_cents,fee_cents,earner_amount_cents,
                               refunded_cents,status,captured_at,earnings_credited)
  values (bid,'pi_cb_probe',10000,700,9300,0,'captured',now(),true) returning id into pid;

  select coalesce(earnings_total,0) into before_total from public.profiles where id = uid;
  -- Seed a balance. debit_earnings floors at zero, so on an account already at 0 the
  -- refund path is indistinguishable from the chargeback path and the probe proves
  -- nothing. Restored below with everything else.
  update public.profiles set earnings_total = before_total + 500 where id = uid;

  -- CHARGEBACK: must not touch the earner's ledger.
  perform public.record_refund(pid, 5000, 'chargeback probe', null, false);
  select coalesce(earnings_total,0) into after_cb from public.profiles where id = uid;

  -- REFUND: must still debit, because reverse_transfer actually recovered the money.
  perform public.record_refund(pid, 5000, 'refund probe', null, true);
  select coalesce(earnings_total,0) into after_refund from public.profiles where id = uid;

  -- Clean up before asserting, so a failure still leaves the account untouched.
  delete from public.payments where id = pid;
  delete from public.bookings where id = bid;
  delete from public.jobs where id = jid;
  update public.profiles set earnings_total = before_total where id = uid;

  if after_cb <> before_total + 500 then
    raise exception 'CHARGEBACK STILL DEBITS: earnings went % -> %', before_total + 500, after_cb;
  end if;
  if after_refund >= after_cb then
    raise exception 'REFUND STOPPED DEBITING: earnings % -> % (should have fallen)', after_cb, after_refund;
  end if;
  raise notice 'chargeback left earnings at %, refund reduced them to % — both paths correct', after_cb, after_refund;
end $$;
