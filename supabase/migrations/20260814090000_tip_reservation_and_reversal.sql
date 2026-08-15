-- ─────────────────────────────────────────────────────────────────────────────
-- Tips: the cap gate becomes a WRITE, and a reversed tip finally leaves a record.
--
-- Two HIGHs from the 2026-08-12 payments audit, both re-verified live on 2026-08-14.
--
-- ── A. The tip caps were bypassable by plain concurrency ────────────────────
--
-- 20260804000000 built the caps correctly IN THE TRIGGER — advisory locks, three caps,
-- no service_role exemption — and then put a `stable`, lock-free READ in front of them:
-- stripe-tip called `tip_headroom_cents` in its own round trip and only afterwards
-- created the PaymentIntent. A read consumes nothing. N concurrent callers therefore all
-- saw the same headroom and all passed, and because the Stripe idempotency key was
-- `tip_${booking}_${cents}`, varying the amount by one cent produced N genuinely distinct
-- PaymentIntents that never collided. The trigger then fired once per attempt, at
-- claim_and_credit_tip time — AFTER the card was charged — and every rejection rolled
-- back its own ledger row, so the over-cap money never counted toward the per-booking
-- total, the count-of-3 or the $500/24h velocity sum. The cap never tightened. The
-- audit's modelled repro moved $19,950 on one $200-cap booking while the ledger recorded
-- $200 of it.
--
-- tipCaps.test.js asserted "checked before the charge" and "the caps are serialised" and
-- was green throughout, because both statements are true of the two transactions taken
-- one at a time. What was never asserted is that the pre-charge gate CONSUMES anything.
--
-- THE FIX: the gate is now a write that goes through the existing trigger.
-- `reserve_tip_slot` INSERTs an uncharged tip_ledger row, so trg_guard_tip_caps
-- evaluates all three caps under its own advisory locks at the moment headroom is taken.
-- There is deliberately NO second copy of the cap arithmetic — the trigger stays the
-- single definition, and `tip_headroom_cents` is demoted from gate to display helper
-- (it now only supplies the "you can add up to $X more" figure on a refusal).
-- `confirm_tip_charge` attaches the real PaymentIntent and does what
-- claim_and_credit_tip does today; `release_tip_reservation` gives the slot back when
-- the charge is definitively dead.
--
-- IF THE FUNCTION DIES BETWEEN RESERVE AND CONFIRM, the reservation must not hold
-- headroom forever. It does not, and without needing a sweep to be alive: a reservation
-- carries `reserved_until`, and every cap query — trigger and helper — counts only rows
-- that are `reserved_until is null` (a real, confirmed tip) or still inside their
-- window. An expired reservation stops consuming headroom by arithmetic, not by
-- housekeeping. The ROW is kept rather than deleted, because a reservation that timed
-- out is also the one shape where money may have moved without being recorded, and
-- ctl_earner_credit_missing (redefined below) is how a human hears about it.
--
-- The reservation key is DETERMINISTIC — `resv_<booking>_<cents>` — and it is the Stripe
-- idempotency key. That preserves the one thing the old key did right: a double-tapped
-- tip collapses onto one reservation and one PaymentIntent. It also makes a retry after
-- a timeout exactly-once rather than merely likely — Stripe replays the same PI and
-- confirm attaches it. The key lives in its own nullable, uniquely-indexed column and is
-- released on confirm, so a second legitimate tip of the same amount on the same booking
-- (the count cap allows three) is not blocked by the first.
--
-- ── B. A refunded or charged-back tip was reversed nowhere ──────────────────
--
-- Every reversal path in this system is keyed on `payments`. stripe-tip writes no
-- payments row at all — a tip exists only in `tip_ledger` — so recordReversal misses,
-- reconcile-stripe never retrieves the PaymentIntent, and admin-payment-action (which
-- loads a payments row by booking_id) offers no console path at all. An operator told to
-- "reverse the tip on booking B" reaches for Refund and reverses the ESCROW charge
-- instead, clawing the earner's job pay out of their connected account.
--
-- `record_tip_reversal` below is the missing writer, with the signature stripe-webhook
-- will be wired to. CUMULATIVE-TARGET semantics: it is handed Stripe's running total for
-- the charge and reverses only the delta, so a redelivered event is a no-op BY
-- CONSTRUCTION rather than by a second idempotency check bolted alongside it. It returns
-- the cents it newly reversed, 0 when already at or above the target, and NULL when the
-- PaymentIntent is not a tip at all — the caller has to be able to tell "not mine" from
-- "already done", or the webhook's fallback silently swallows what it cannot attribute.
--
-- WHETHER THE EARNER IS DEBITED follows 20260813160000 exactly, because the mechanics
-- are identical: a tip is a destination charge, so a CHARGEBACK debits the platform
-- balance and does not reverse the transfer — the money is already with the earner and
-- stays there. Debiting them would be "a cosmetic decrement that makes a number wrong",
-- in that migration's words, for something the poster's cardholder did. A REFUND is the
-- other case: this platform cannot refund a tip without reversing the transfer, because
-- a tip carries no application_fee_amount, so refunding without `reverse_transfer` would
-- pay the tip out of the platform's own pocket. So refund debits, chargeback does not,
-- and the branch reads the same 'Stripe chargeback%' prefix that
-- ctl_external_reversal_not_ledgered already parses and reversalReasonParity.test.js
-- already pins. What was ACTUALLY taken is RECORDED in earner_reversed_cents rather than
-- re-derived later — the whole lesson of 20260814050000.
--
-- Residual, stated rather than hidden: a Stripe DASHBOARD refund that leaves the transfer
-- alone would debit an earner who kept the money. The figure is recorded on the row and
-- correctable; the alternative — never debiting — would make the control CTE below a
-- detector that always sums zero, which is this repo's other favourite failure.
--
-- ── C. …and ctl_earnings_total_drift certified the result ───────────────────
--
-- The control's `tipped` CTE adds every credited tip_ledger row and its `clawed` CTE
-- draws only from payments.earner_refunded_cents. With no tip reversal recorded anywhere,
-- stored == expected EXACTLY and the control called it healthy. Now that a reversal
-- debits, the control MUST subtract it or every correctly handled reversal becomes a
-- permanent, unresolvable HIGH finding against a real earner — the exact failure
-- 20260814050000 fixed on the escrow leg. `tip_clawed` is added here, in the same
-- migration as the writer, for that reason. Redefined from the CURRENT body
-- (20260814050000), not the 20260806040000 the audit read.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The two new row states ───────────────────────────────────────────────────
alter table public.tip_ledger
  add column if not exists reservation_key       text,
  add column if not exists reserved_until        timestamptz,
  add column if not exists reversed_cents        integer not null default 0,
  add column if not exists earner_reversed_cents integer not null default 0,
  add column if not exists reversed_at           timestamptz,
  add column if not exists reversal_reason       text;

-- A reservation has no PaymentIntent yet — that is the whole point of reserving before
-- charging — so the column can no longer be NOT NULL. The guarantee that mattered is kept
-- as a constraint instead: a row is either a charge or a reservation, never neither.
alter table public.tip_ledger alter column payment_intent_id drop not null;

alter table public.tip_ledger drop constraint if exists tip_ledger_charge_or_reservation;
alter table public.tip_ledger add constraint tip_ledger_charge_or_reservation
  check (payment_intent_id is not null or reserved_until is not null);

-- Partial + unique: the index IS the double-tap collapse. Two simultaneous taps race to
-- insert the same deterministic key and exactly one wins; the loser reads the winner's
-- row and charges under the SAME Stripe idempotency key, so one PaymentIntent exists.
-- Freed on confirm, so three legitimate tips of one amount on one booking still fit.
create unique index if not exists tip_ledger_reservation_key_uidx
  on public.tip_ledger (reservation_key) where reservation_key is not null;

comment on column public.tip_ledger.reserved_until is
  'Set while a slot is reserved and not yet charged; cleared by confirm_tip_charge. Every '
  'cap query counts a row only when this is null or still in the future, so a reservation '
  'stranded by a dead invocation stops consuming headroom on its own rather than waiting '
  'for a sweep that might not run.';
comment on column public.tip_ledger.reversed_cents is
  'Cumulative cents reversed at Stripe for this tip (refund or chargeback). The TARGET, '
  'not a delta — record_tip_reversal is handed Stripe running totals, so redelivery is a '
  'no-op by construction.';
comment on column public.tip_ledger.earner_reversed_cents is
  'Cents actually taken back off the earner''s in-app ledger. 0 on a chargeback: a tip is '
  'a destination charge, so the platform balance is debited and the transfer is not '
  'reversed (20260813160000). Recorded, never recomputed.';

-- ── The trigger keeps being the single definition of the caps ────────────────
-- Unchanged arithmetic. Two edits only: reservations are counted (that is how the gate
-- consumes headroom), and an EXPIRED reservation is not (that is how a stranded one stops
-- consuming it). Note what is deliberately NOT here: a reversal does not give headroom
-- back. Caps bound gross movement through the rail, and a charged-back tip is the abuse
-- signal itself — refunding headroom on it would let the same money be recycled.
create or replace function public.guard_tip_caps()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_captured_cents  bigint;
  v_existing_cents  bigint;
  v_existing_count  integer;
  v_cap_cents       bigint;
  v_poster          uuid;
  v_poster_24h      bigint;
begin
  -- IDEMPOTENT REPLAY — let it through untouched.
  --
  -- claim_and_credit_tip() does `insert ... on conflict (payment_intent_id) do nothing`,
  -- and in PostgreSQL a BEFORE INSERT row trigger fires BEFORE conflict arbitration. So
  -- on a legitimate retry this guard would run again and count the ALREADY-STORED row as
  -- if it were a second tip — rejecting a $150 tip on its own retry and aborting the
  -- whole credit transaction, stranding a charged tip uncredited: precisely the failure
  -- the caps are meant to prevent.
  --
  -- A RESERVATION carries no payment_intent_id, so it never takes this path and always
  -- has its caps evaluated. That is the point of the reservation.
  if new.payment_intent_id is not null and exists (
    select 1 from public.tip_ledger where payment_intent_id = new.payment_intent_id
  ) then
    return new;
  end if;

  -- SERIALISE BEFORE READING.
  --
  -- Every cap below is a read-then-decide over rows another transaction may be inserting
  -- concurrently. Under READ COMMITTED (what PostgREST uses) an uncommitted tip_ledger
  -- row is invisible, so N parallel tips would each read an empty ledger and each
  -- conclude they were the first. Advisory locks are held for the rest of the transaction
  -- and released automatically on commit/rollback.
  --
  -- Resolve the poster FIRST and always take poster-lock then booking-lock, in that fixed
  -- order, so two concurrent tips can never grab them in opposite orders and deadlock.
  select j.poster_id
    into v_poster
    from public.bookings b
    join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  if v_poster is not null then
    perform pg_advisory_xact_lock(hashtextextended('gohustlr.tip.poster:' || v_poster::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gohustlr.tip.booking:' || new.booking_id::text, 0));

  -- What this booking actually collected. amount_cents is the original AUTHORIZATION and
  -- is never rewritten, so the captured total is the split: earner_amount_cents +
  -- fee_cents (see stripe-capture-payment).
  select coalesce(sum(coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0)), 0)
    into v_captured_cents
    from public.payments p
   where p.booking_id = new.booking_id
     and p.status = 'captured';

  select coalesce(sum(t.amount_cents), 0), count(*)
    into v_existing_cents, v_existing_count
    from public.tip_ledger t
   where t.booking_id = new.booking_id
     and (t.reserved_until is null or t.reserved_until > now());

  -- Cap 2 — count.
  if v_existing_count >= 3 then
    raise exception 'tip_cap_count'
      using errcode = 'check_violation',
            hint = 'This gig has already been tipped the maximum number of times.';
  end if;

  -- Cap 1 — per-booking total.
  v_cap_cents := greatest(v_captured_cents * 2, 20000);
  if v_existing_cents + new.amount_cents > v_cap_cents then
    raise exception 'tip_cap_booking'
      using errcode = 'check_violation',
            hint = 'That tip is larger than this gig allows. Tips are capped relative to the job total.';
  end if;

  -- Cap 3 — poster velocity over a rolling 24h, across ALL their bookings. The
  -- per-booking cap alone is evaded by spreading the same money over many small fake
  -- gigs, which is the shape laundering actually takes.
  if v_poster is not null then
    select coalesce(sum(t.amount_cents), 0)
      into v_poster_24h
      from public.tip_ledger t
      join public.bookings b on b.id = t.booking_id
      join public.jobs j on j.id = b.job_id
     where j.poster_id = v_poster
       and t.created_at >= now() - interval '24 hours'
       and (t.reserved_until is null or t.reserved_until > now());

    if v_poster_24h + new.amount_cents > 50000 then
      raise exception 'tip_cap_velocity'
        using errcode = 'check_violation',
              hint = 'You have reached the daily tipping limit. Try again tomorrow.';
    end if;
  end if;

  return new;
end;
$fn$;

revoke execute on function public.guard_tip_caps() from public, anon, authenticated;

drop trigger if exists trg_guard_tip_caps on public.tip_ledger;
create trigger trg_guard_tip_caps
  before insert on public.tip_ledger
  for each row execute function public.guard_tip_caps();

-- ── Demoted: display copy, no longer the gate ────────────────────────────────
-- This used to be what stood between a card and an uncapped charge, which is why it was
-- the bug. It now runs only on a REFUSAL, to turn "no" into "you can add up to $X more".
-- It still has to agree with the trigger literal-for-literal: a helper that quoted a
-- larger figure than the trigger will grant would send the poster round the loop again.
create or replace function public.tip_headroom_cents(p_booking uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  v_captured_cents bigint;
  v_existing_cents bigint;
  v_existing_count integer;
  v_cap_cents      bigint;
  v_poster         uuid;
  v_poster_24h     bigint;
  v_headroom       bigint;
begin
  select coalesce(sum(coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0)), 0)
    into v_captured_cents
    from public.payments p
   where p.booking_id = p_booking and p.status = 'captured';

  select coalesce(sum(t.amount_cents), 0), count(*)
    into v_existing_cents, v_existing_count
    from public.tip_ledger t
   where t.booking_id = p_booking
     and (t.reserved_until is null or t.reserved_until > now());

  if v_existing_count >= 3 then
    return jsonb_build_object('headroom_cents', 0, 'reason', 'tip_cap_count');
  end if;

  v_cap_cents := greatest(v_captured_cents * 2, 20000);
  v_headroom := v_cap_cents - v_existing_cents;

  select j.poster_id into v_poster
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = p_booking;

  if v_poster is not null then
    select coalesce(sum(t.amount_cents), 0)
      into v_poster_24h
      from public.tip_ledger t
      join public.bookings b on b.id = t.booking_id
      join public.jobs j on j.id = b.job_id
     where j.poster_id = v_poster
       and t.created_at >= now() - interval '24 hours'
       and (t.reserved_until is null or t.reserved_until > now());

    if 50000 - v_poster_24h < v_headroom then
      v_headroom := 50000 - v_poster_24h;
      if v_headroom <= 0 then
        return jsonb_build_object('headroom_cents', 0, 'reason', 'tip_cap_velocity');
      end if;
    end if;
  end if;

  if v_headroom <= 0 then
    return jsonb_build_object('headroom_cents', 0, 'reason', 'tip_cap_booking');
  end if;
  return jsonb_build_object('headroom_cents', v_headroom, 'reason', null);
end;
$fn$;

revoke execute on function public.tip_headroom_cents(uuid) from public, anon, authenticated;
grant execute on function public.tip_headroom_cents(uuid) to service_role;

-- ── The gate: a WRITE that consumes headroom under the trigger's locks ───────
-- The earner is resolved from the booking rather than taken as a parameter. It used to
-- be passed in from the edge function; there is no reason for the credit destination of a
-- card charge to be an argument the caller supplies.
create or replace function public.reserve_tip_slot(p_booking uuid, p_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key    text;
  v_id     uuid;
  v_earner uuid;
  v_reason text;
  v_head   jsonb;
begin
  if p_booking is null or p_cents is null or p_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'tip_invalid');
  end if;

  select b.earner_id into v_earner from public.bookings b where b.id = p_booking;
  if v_earner is null then
    return jsonb_build_object('ok', false, 'reason', 'tip_invalid');
  end if;

  -- Deterministic, and it doubles as the Stripe idempotency key. See the header: this is
  -- what keeps a double-tap — and a retry after a timeout — to exactly one PaymentIntent.
  v_key := 'resv_' || p_booking::text || '_' || p_cents::text;

  -- RETIRE a reservation that timed out without ever being confirmed: free the key so
  -- this attempt can take it, but leave reserved_until in the past so the row still does
  -- not consume headroom, and leave the ROW so ctl_earner_credit_missing can raise it. A
  -- delete here would erase the only trace of an invocation that may have charged a card
  -- before it died.
  --
  -- Retire by RENAMING, never by nulling. A nulled key makes the retired row
  -- unaddressable forever: release_tip_reservation matches on `reservation_key = p_key`
  -- and null equals nothing, while confirm_tip_charge would find the NEW row under that
  -- key. The row would then sit uncredited, PI-null and key-null — a permanent finding no
  -- remedy can clear, which is the exact shape 20260814050000 was written to end. Worse,
  -- an operator following the printed remedy with the reconstructed key would release the
  -- LIVE reservation instead and hand headroom back mid-charge.
  --
  -- Suffixing with the row id keeps it unique (the partial unique index still holds),
  -- keeps it addressable, and makes it obvious in the table which rows are corpses.
  update public.tip_ledger
     set reservation_key = v_key || '_retired_' || id::text
   where reservation_key = v_key
     and reserved_until is not null
     and reserved_until <= now()
     and coalesce(credited, false) = false
     and payment_intent_id is null;

  -- REUSE an existing live reservation for this exact slot, BEFORE trying to insert.
  --
  -- This cannot be left to the insert's unique_violation branch. trg_guard_tip_caps is a
  -- BEFORE INSERT trigger, so on a repeated identical tip it evaluates the caps INCLUDING
  -- the reservation already held — 15000 + 15000 against a 20000 booking cap — and raises
  -- tip_cap_booking before the unique index is ever consulted. The double-tap collapse
  -- would never fire, and the poster would be told their own second tap put them over the
  -- cap. The probe below catches exactly that.
  --
  -- An EXPIRED reservation was renamed by the retire step above, and a CONFIRMED one has
  -- its key nulled, so neither matches here — only a live slot is reused.
  select id into v_id
    from public.tip_ledger
   where reservation_key = v_key
     and coalesce(credited, false) = false;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'key', v_key, 'reservation_id', v_id);
  end if;

  begin
    insert into public.tip_ledger
      (booking_id, payment_intent_id, reservation_key, earner_id, amount_cents, reserved_until)
    values
      (p_booking, null, v_key, v_earner, p_cents, now() + interval '10 minutes')
    returning id into v_id;
  exception
    when unique_violation then
      -- Someone already holds this exact slot. Fall through and reuse it — that IS the
      -- double-tap collapse, and it must not consume a second slot.
      v_id := null;
    when check_violation then
      v_reason := sqlerrm;
      -- Only the cap trigger speaks this dialect. Anything else (a table CHECK, say) is
      -- not a cap decision and must not be reported to the poster as one.
      if v_reason not like 'tip_cap_%' then
        raise;
      end if;
  end;

  if v_reason is not null then
    v_head := public.tip_headroom_cents(p_booking);
    return jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'headroom_cents', greatest(0, coalesce((v_head->>'headroom_cents')::bigint, 0))
    );
  end if;

  if v_id is null then
    select id into v_id from public.tip_ledger where reservation_key = v_key;
    if v_id is null then
      -- The conflicting row vanished between the insert and this read. Refuse rather than
      -- charge: an unreserved charge is the bug this function exists to end.
      return jsonb_build_object('ok', false, 'reason', 'tip_reserve_failed');
    end if;
  end if;

  return jsonb_build_object('ok', true, 'key', v_key, 'reservation_id', v_id);
end;
$fn$;

revoke execute on function public.reserve_tip_slot(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_tip_slot(uuid, integer) to service_role;

-- ── Attach the real PaymentIntent and credit — what claim_and_credit_tip did ─
create or replace function public.confirm_tip_charge(p_key text, p_pi text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id      uuid;
  v_booking uuid;
  v_earner  uuid;
  v_cents   integer;
  v_claimed boolean := false;
begin
  if p_key is null or p_pi is null then
    return false;
  end if;

  -- Already attached: a retry whose response was lost, or a Stripe idempotent replay
  -- handing back the same PaymentIntent. Look here FIRST — the reservation key is
  -- released on confirm, so after a successful pass the PI is the only handle left.
  select id, booking_id, earner_id, amount_cents
    into v_id, v_booking, v_earner, v_cents
    from public.tip_ledger
   where payment_intent_id = p_pi
   for update;

  if v_id is null then
    select id, booking_id, earner_id, amount_cents
      into v_id, v_booking, v_earner, v_cents
      from public.tip_ledger
     where reservation_key = p_key
     for update;
  end if;

  -- No reservation and no charge row. The card has been charged and there is nowhere to
  -- record it; the caller pages a human rather than returning success.
  if v_id is null then
    return false;
  end if;

  -- An EXPIRED reservation still confirms. Expiry only stops a row consuming headroom;
  -- it does not withdraw permission for a charge that already happened. This is an
  -- UPDATE, so trg_guard_tip_caps does not re-run — deliberately. Refusing to record
  -- money that has already left the poster's card, because a cap has since filled up, is
  -- the charged-but-uncredited failure with extra steps.

  -- Claim the credit: only the call that flips credited false->true increments, so a
  -- retry after a mid-way failure still credits exactly once. One transaction with the
  -- increments below, so a failure rolls the claim back.
  update public.tip_ledger
     set payment_intent_id = p_pi,
         reservation_key   = null,
         reserved_until    = null,
         credited          = true
   where id = v_id
     and coalesce(credited, false) = false
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    -- Credited already. Still make sure the durable handle is the PaymentIntent, not a
    -- reservation key that a later reserve would recycle.
    update public.tip_ledger
       set payment_intent_id = p_pi, reservation_key = null, reserved_until = null
     where id = v_id and payment_intent_id is null;
    return true;
  end if;

  if v_booking is not null then
    update public.bookings
       set tip_amount = coalesce(tip_amount, 0) + v_cents::numeric / 100
     where id = v_booking;
  end if;
  if v_earner is not null then
    perform public.roll_earnings_period(v_earner);  -- see credit_earnings
    update public.profiles
       set earnings_today = coalesce(earnings_today, 0) + v_cents::numeric / 100,
           earnings_week  = coalesce(earnings_week,  0) + v_cents::numeric / 100,
           earnings_total = coalesce(earnings_total, 0) + v_cents::numeric / 100
     where id = v_earner;
  end if;

  return true;
end;
$fn$;

revoke execute on function public.confirm_tip_charge(text, text) from public, anon, authenticated;
grant execute on function public.confirm_tip_charge(text, text) to service_role;

-- ── Give the slot back when the charge is definitively dead ──────────────────
-- Only ever removes a row that is still a reservation: no PaymentIntent, not credited. A
-- confirmed tip can never be deleted through this.
create or replace function public.release_tip_reservation(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_n integer;
begin
  if p_key is null then
    return false;
  end if;
  delete from public.tip_ledger
   where reservation_key = p_key
     and payment_intent_id is null
     and coalesce(credited, false) = false;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$fn$;

revoke execute on function public.release_tip_reservation(text) from public, anon, authenticated;
grant execute on function public.release_tip_reservation(text) to service_role;

-- ── The missing reversal writer ──────────────────────────────────────────────
-- Signature is fixed by the caller stripe-webhook will grow: (payment_intent, cumulative
-- target, reason) -> cents newly reversed. NULL means "this PaymentIntent is not a tip",
-- which is a different answer from 0 ("already reversed to at least that figure") and the
-- webhook needs to be able to tell them apart before it decides whether to keep looking.
create or replace function public.record_tip_reversal(
  p_payment_intent text,
  p_target_cents   integer,
  p_reason         text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id        uuid;
  v_booking   uuid;
  v_earner    uuid;
  v_amount    integer;
  v_reversed  integer;
  v_credited  boolean;
  v_target    integer;
  v_delta     integer;
  v_debit     boolean;
  v_dollars   numeric;
begin
  if p_payment_intent is null then
    return null;
  end if;

  select id, booking_id, earner_id, amount_cents,
         coalesce(reversed_cents, 0), coalesce(credited, false)
    into v_id, v_booking, v_earner, v_amount, v_reversed, v_credited
    from public.tip_ledger
   where payment_intent_id = p_payment_intent
   for update;

  if v_id is null then
    return null;
  end if;

  -- CUMULATIVE TARGET, clamped to what was actually charged. Stripe hands out running
  -- totals (charge.amount_refunded), so a redelivered event carries the SAME number as
  -- the first delivery and the delta below is zero. That is idempotency by construction,
  -- not a second check that can be dropped in a rewrite.
  v_target := least(greatest(coalesce(p_target_cents, 0), 0), coalesce(v_amount, 0));
  v_delta := v_target - v_reversed;
  if v_delta <= 0 then
    return 0;
  end if;

  -- Does this reversal actually take the money back off the earner? See the header. A
  -- chargeback on a destination charge does not (20260813160000); a refund of a tip has
  -- to, because a tip carries no application fee and the platform would otherwise be
  -- funding it. The prefix is the same contract ctl_external_reversal_not_ledgered reads
  -- and reversalReasonParity.test.js pins against stripe-webhook's own template.
  v_debit := coalesce(p_reason, '') not ilike 'Stripe chargeback%';

  update public.tip_ledger
     set reversed_cents        = v_target,
         earner_reversed_cents = coalesce(earner_reversed_cents, 0)
                                 + case when v_debit and v_credited then v_delta else 0 end,
         reversed_at           = now(),
         reversal_reason       = left(coalesce(p_reason, 'reversed'), 500)
   where id = v_id;

  -- Nothing was ever credited, so there is nothing to take back. Mirrors debit_earnings,
  -- which refuses for the same reason: debiting an earner for money they never received
  -- is the failure, not the safeguard.
  if not v_debit or not v_credited then
    return v_delta;
  end if;

  v_dollars := v_delta::numeric / 100;
  if v_booking is not null then
    update public.bookings
       set tip_amount = greatest(0, coalesce(tip_amount, 0) - v_dollars)
     where id = v_booking;
  end if;
  if v_earner is not null then
    perform public.roll_earnings_period(v_earner);
    update public.profiles
       set earnings_today = greatest(0, coalesce(earnings_today, 0) - v_dollars),
           earnings_week  = greatest(0, coalesce(earnings_week,  0) - v_dollars),
           earnings_total = greatest(0, coalesce(earnings_total, 0) - v_dollars)
     where id = v_earner;
  end if;

  return v_delta;
end;
$fn$;

revoke execute on function public.record_tip_reversal(text, integer, text) from public, anon, authenticated;
grant execute on function public.record_tip_reversal(text, integer, text) to service_role;

-- ── The control has to be able to see the reversal it now causes ─────────────
create or replace function public.ctl_earnings_total_drift()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$with credited as (
  select b.earner_id as uid, sum(coalesce(p.earner_amount_cents, 0))::bigint as cents
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where coalesce(p.earnings_credited, false)
   group by b.earner_id
),
tipped as (
  select t.earner_id as uid, sum(coalesce(t.amount_cents, 0))::bigint as cents
    from public.tip_ledger t
   where coalesce(t.credited, false) and t.earner_id is not null
   group by t.earner_id
),
tip_clawed as (
  -- Reads what record_tip_reversal RECORDED as taken, for exactly the reason the CTE
  -- below reads payments.earner_refunded_cents: a chargeback reverses no transfer, so a
  -- reversal is not automatically an earner loss. Without this CTE at all, every
  -- correctly handled tip refund would open a permanent unresolvable HIGH finding — and
  -- before there was any reversal writer, a fully reversed tip left stored == expected
  -- exactly and this control certified it.
  select t.earner_id as uid,
         sum(coalesce(t.earner_reversed_cents, 0))::bigint as cents,
         count(*)::int as n
    from public.tip_ledger t
   where coalesce(t.credited, false) and t.earner_id is not null
     and coalesce(t.reversed_cents, 0) > 0
   group by t.earner_id
),
clawed as (
  -- Reads what was RECORDED as taken. The old body rebuilt this proportionally from
  -- refunded_cents, which since 20260813160000 is wrong on every lost chargeback.
  select b.earner_id as uid,
         sum(coalesce(p.earner_refunded_cents, 0))::bigint as cents,
         count(*)::int as n
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where coalesce(p.refunded_cents, 0) > 0
     and coalesce(p.earnings_credited, false)
   group by b.earner_id
)
select
  pr.id::text as entity_id,
  jsonb_build_object(
    'stored_earnings_total', pr.earnings_total,
    'expected_earnings_total', e.expected,
    'delta_dollars', round(coalesce(pr.earnings_total, 0) - e.expected, 2),
    'captured_credited_cents', coalesce(c.cents, 0),
    'tips_credited_cents', coalesce(t.cents, 0),
    'refund_clawback_cents', coalesce(r.cents, 0),
    'refunded_payments', coalesce(r.n, 0),
    'tip_clawback_cents', coalesce(tr.cents, 0),
    'reversed_tips', coalesce(tr.n, 0),
    'tolerance_dollars', e.tol
  ) as detail
from public.profiles pr
left join credited   c  on c.uid  = pr.id
left join tipped     t  on t.uid  = pr.id
left join clawed     r  on r.uid  = pr.id
left join tip_clawed tr on tr.uid = pr.id
cross join lateral (
  select
    round(greatest(0::bigint, coalesce(c.cents, 0) + coalesce(t.cents, 0)
                              - coalesce(r.cents, 0) - coalesce(tr.cents, 0))::numeric / 100, 2) as expected,
    -- Both clawback figures are exact integers now, so there is no per-call rounding
    -- slack to absorb; 2c stays for the dollars/cents conversion.
    0.02::numeric as tol
) e
where abs(coalesce(pr.earnings_total, 0) - e.expected) > e.tol$ctl$;
revoke execute on function public.ctl_earnings_total_drift() from public, anon, authenticated;

update public.controls
   set why = 'profiles.earnings_total has four writers — credit_earnings (+earner_amount_cents on '
             'capture), confirm_tip_charge (+amount_cents, tips carry no platform fee), '
             'debit_earnings (called only from record_refund) and record_tip_reversal. Both '
             'clawbacks are READ from what was recorded — payments.earner_refunded_cents and '
             'tip_ledger.earner_reversed_cents — rather than rebuilt from a formula: a LOST '
             'CHARGEBACK on either leg raises the reversed figure and deliberately debits nothing '
             '(20260813160000 — the platform absorbs a destination-charge reversal), so a '
             'proportional form expects a clawback that never happened and opens a permanent '
             'unresolvable finding on the first one. Before 20260814090000 there was no tip '
             'reversal writer at all, so a fully reversed tip left stored == expected exactly and '
             'this control reported the inflated balance as healthy. guard_profiles_write pins the '
             'column for the owner, so no client can touch it: the balance is an exact derived '
             'quantity that nothing in the database enforces, which is why this control catches '
             'every credit/debit bug at once.'
 where key = 'earnings_total_drift';

-- ── Blast radius: the stale-tip control now sees a second row shape ──────────
-- ctl_earner_credit_missing flags every uncredited tip_ledger row older than 15 minutes
-- as 'tip_charged_not_credited' and tells the operator to run claim_and_credit_tip. A
-- reservation is uncredited by definition, so without this it would report every timed-out
-- reservation as a charged-but-uncredited tip and hand out a remedy that credits an earner
-- for a card that may never have been charged. The two shapes are now named apart, and the
-- reservation arm carries the Stripe idempotency key to check before deciding — which is
-- reconstructible from the row even after reserve_tip_slot has retired the key.
--
-- The 15-minute staleness window is deliberately longer than the 10-minute reservation
-- TTL, so a reservation expires and stops consuming headroom BEFORE it is reported.
-- ⚠️ THE ESCROW ARM STAYS. This control is a UNION of two unrelated shapes and only the
-- TIP half needed changing. A redefinition that kept just the tip half would not merely go
-- blind to "money captured from a poster and never credited to the earner" — run_control
-- auto-resolves anything a control stops returning, scoped only by control_key, so the
-- first sweep after this migration would silently close every OPEN finding of that kind,
-- on real unremediated captures. Nothing else can see them either: ctl_payment_ledger_
-- impossible tests the opposite direction, and ctl_earnings_total_drift's `credited` CTE
-- filters on earnings_credited, so an uncredited capture is absent from both stored and
-- expected and nets to zero drift. That is exactly why this arm exists.
create or replace function public.ctl_earner_credit_missing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  p.id::text as entity_id,
  jsonb_build_object(
    'kind', 'escrow_capture_not_credited',
    'booking_id', p.booking_id,
    'earner_id', b.earner_id,
    'payment_intent_id', p.payment_intent_id,
    'earner_amount_cents', p.earner_amount_cents,
    'fee_cents', p.fee_cents,
    'captured_at', p.captured_at,
    'minutes_stale', round(extract(epoch from now() - coalesce(p.captured_at, p.created_at, 'epoch'::timestamptz)) / 60)::int,
    'remedy', 'service_role: select public.credit_earnings(<this payments.id>)'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
where p.status = 'captured'
  and coalesce(p.earnings_credited, false) = false
  and coalesce(p.captured_at, p.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'
union all
select
  t.id::text,
  jsonb_build_object(
    'kind', case when t.payment_intent_id is not null
                 then 'tip_charged_not_credited'
                 else 'tip_reservation_unconfirmed' end,
    'booking_id', t.booking_id,
    'earner_id', t.earner_id,
    'payment_intent_id', t.payment_intent_id,
    'amount_cents', t.amount_cents,
    'charged_at', t.created_at,
    'minutes_stale', round(extract(epoch from now() - coalesce(t.created_at, 'epoch'::timestamptz)) / 60)::int,
    -- The row's OWN key, never a reconstruction. `resv_<booking>_<cents>` rebuilt from
    -- the columns is correct only for a LIVE reservation; on a retired one that string
    -- now names whichever reservation took the slot afterwards, so an operator following
    -- this remedy would release a live reservation mid-charge. Stripe's idempotency key
    -- is the pre-retire prefix, which is the key minus the `_retired_<id>` suffix.
    'reservation_key', t.reservation_key,
    'stripe_idempotency_key',
      coalesce(split_part(t.reservation_key, '_retired_', 1),
               'resv_' || t.booking_id::text || '_' || t.amount_cents::text),
    'remedy', case when t.payment_intent_id is not null
      then 'The card WAS charged and the earner was not credited. service_role: select '
           'public.confirm_tip_charge(reservation_key, payment_intent_id) — or, for a row '
           'predating reservations, public.claim_and_credit_tip(payment_intent_id, booking_id, '
           'earner_id, amount_cents). Refunding the PaymentIntent in Stripe is the alternative.'
      else 'A tip slot was reserved and never confirmed, so stripe-tip died mid-charge. Look '
           'up the PaymentIntent Stripe created under the idempotency key in this detail. If it '
           'SUCCEEDED the poster was charged and the earner was not: service_role select '
           'public.confirm_tip_charge(<reservation_key from this detail>, <pi>). If it does not exist '
           'or did not succeed, no money moved: service_role select '
           'public.release_tip_reservation(<reservation_key from this detail>). The row is '
           'already excluded from the tip caps, so it is holding no headroom while you decide.'
    end
  )
from public.tip_ledger t
where coalesce(t.credited, false) = false
  and coalesce(t.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'$ctl$;
revoke execute on function public.ctl_earner_credit_missing() from public, anon, authenticated;

-- ── Prove both fixes discriminate, on the same staged data, rolled back ──────
do $$
declare
  uid uuid;
  jid_a uuid; jid_b uuid; jid_c uuid;
  bid_a uuid; bid_b uuid; bid_c uuid;
  r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb;
  h1 bigint; h2 bigint; h3 bigint; h4 bigint; h5 bigint;
  e0 numeric; e1 numeric; e2 numeric;
  n1 integer; n2 integer; n3 integer;
  d0 numeric; det jsonb;
  v_rev integer; v_earner_rev integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- bookings is unique(job_id, earner_id), so three bookings need three jobs.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'tip cap probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_a;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'tip refund probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_b;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'tip chargeback probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid_c;
  insert into public.bookings (job_id, earner_id, status) values (jid_a, uid, 'verified') returning id into bid_a;
  insert into public.bookings (job_id, earner_id, status) values (jid_b, uid, 'verified') returning id into bid_b;
  insert into public.bookings (job_id, earner_id, status) values (jid_c, uid, 'verified') returning id into bid_c;

  -- ══ A1. THE BUG, on real data: the old gate consumed nothing ══════════════
  -- Two callers asking the pre-charge gate in their own transactions is exactly what
  -- stripe-tip did, and this is the answer they both got.
  h1 := (public.tip_headroom_cents(bid_a)->>'headroom_cents')::bigint;
  h2 := (public.tip_headroom_cents(bid_a)->>'headroom_cents')::bigint;
  if h1 <> 20000 or h2 <> h1 then
    raise exception 'probe cannot discriminate: headroom floor is % / %', h1, h2;
  end if;
  raise notice 'OLD gate: two consecutive pre-charge checks both return %c — a read consumes nothing', h1;

  -- ══ A2. THE FIX: the gate is a write, so it consumes ══════════════════════
  r1 := public.reserve_tip_slot(bid_a, 15000);
  if not coalesce((r1->>'ok')::boolean, false) then
    raise exception 'a tip inside the cap was refused: %', r1;
  end if;
  h3 := (public.tip_headroom_cents(bid_a)->>'headroom_cents')::bigint;
  if h3 <> 5000 then
    raise exception 'FIX FAILED: reserving 15000c left %c of headroom, expected 5000c', h3;
  end if;

  -- The attack itself: a second caller at a DIFFERENT amount, which is what produced a
  -- distinct idempotency key and therefore a distinct PaymentIntent. 15000 + 14999 is
  -- $99.99 over a $200 cap, and under the old gate both passed.
  r2 := public.reserve_tip_slot(bid_a, 14999);
  if coalesce((r2->>'ok')::boolean, false) then
    raise exception 'FIX FAILED: a second over-cap tip was admitted (15000 + 14999 > 20000)';
  end if;
  if r2->>'reason' <> 'tip_cap_booking' then
    raise exception 'refused for the wrong reason: %', r2;
  end if;
  if coalesce((r2->>'headroom_cents')::bigint, -1) <> 5000 then
    raise exception 'refusal quoted %c of remaining headroom, expected 5000c', r2->>'headroom_cents';
  end if;
  raise notice 'discriminates: the same two calls that both passed the read gate now give ok + %', r2->>'reason';

  -- A3. A double tap must still collapse onto ONE reservation and one Stripe key.
  r3 := public.reserve_tip_slot(bid_a, 15000);
  if not coalesce((r3->>'ok')::boolean, false) or (r3->>'key') is distinct from (r1->>'key') then
    raise exception 'a repeated identical tip did not reuse its reservation: % vs %', r3, r1;
  end if;
  if (public.tip_headroom_cents(bid_a)->>'headroom_cents')::bigint <> 5000 then
    raise exception 'a repeated identical tip consumed a second slot';
  end if;

  -- A4. A reservation stranded by a dead invocation must not hold headroom forever.
  update public.tip_ledger set reserved_until = now() - interval '1 minute'
   where reservation_key = (r1->>'key');
  h4 := (public.tip_headroom_cents(bid_a)->>'headroom_cents')::bigint;
  if h4 <> 20000 then
    raise exception 'FIX FAILED: an expired reservation still holds %c of headroom', 20000 - h4;
  end if;
  raise notice 'a stranded reservation stops consuming headroom on its own (%c restored)', h4;

  -- ...and re-reserving retires it rather than deleting it, so the possible charge stays
  -- visible to ctl_earner_credit_missing.
  r4 := public.reserve_tip_slot(bid_a, 15000);
  if not coalesce((r4->>'ok')::boolean, false) then
    raise exception 'could not re-reserve after expiry: %', r4;
  end if;
  -- Retired rows keep an ADDRESSABLE key (`..._retired_<id>`), not a null one. A null key
  -- would leave the corpse unreachable by release_tip_reservation forever while
  -- confirm_tip_charge resolved that key to the NEW row — a permanent finding no remedy
  -- could clear, and a remedy that would release the LIVE reservation if followed.
  if not exists (
    select 1 from public.tip_ledger
     where booking_id = bid_a and payment_intent_id is null
       and reservation_key like 'resv\_%\_retired\_%'
       and coalesce(credited, false) = false
  ) then
    raise exception 'the expired reservation was destroyed instead of retired';
  end if;
  if not exists (
    select 1 from public.ctl_earner_credit_missing()
     where (detail->>'kind') = 'tip_reservation_unconfirmed'
  ) then
    -- created_at is now(), so it is not stale yet — force the age the control looks at.
    update public.tip_ledger set created_at = now() - interval '30 minutes'
     where booking_id = bid_a and payment_intent_id is null
       and reservation_key like 'resv\_%\_retired\_%';
    if not exists (
      select 1 from public.ctl_earner_credit_missing()
       where (detail->>'kind') = 'tip_reservation_unconfirmed'
    ) then
      raise exception 'a retired reservation is invisible to ctl_earner_credit_missing';
    end if;
  end if;

  -- A5. Release gives the slot straight back.
  if not public.release_tip_reservation(r4->>'key') then
    raise exception 'release_tip_reservation did not remove a live reservation';
  end if;
  h5 := (public.tip_headroom_cents(bid_a)->>'headroom_cents')::bigint;
  if h5 <> 20000 then
    raise exception 'releasing a reservation left %c of headroom, expected 20000c', h5;
  end if;

  -- A6. Confirm credits exactly once, and a retry is a no-op.
  r5 := public.reserve_tip_slot(bid_a, 5000);
  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  if not public.confirm_tip_charge(r5->>'key', 'pi_tip_probe_confirm') then
    raise exception 'confirm_tip_charge refused a live reservation';
  end if;
  select coalesce(earnings_total, 0) into e1 from public.profiles where id = uid;
  if e1 <> e0 + 50.00 then
    raise exception 'confirm credited % instead of 50.00', e1 - e0;
  end if;
  if not public.confirm_tip_charge(r5->>'key', 'pi_tip_probe_confirm') then
    raise exception 'a confirm retry reported failure';
  end if;
  select coalesce(earnings_total, 0) into e2 from public.profiles where id = uid;
  if e2 <> e1 then
    raise exception 'FIX FAILED: a confirm retry credited a second time (% -> %)', e1, e2;
  end if;

  -- A7. The count cap still bites, now counting reservations.
  if not coalesce((public.reserve_tip_slot(bid_a, 1000)->>'ok')::boolean, false) then
    raise exception 'second slot on this booking was refused';
  end if;
  if not coalesce((public.reserve_tip_slot(bid_a, 1100)->>'ok')::boolean, false) then
    raise exception 'third slot on this booking was refused';
  end if;
  if (public.reserve_tip_slot(bid_a, 1200)->>'reason') is distinct from 'tip_cap_count' then
    raise exception 'FIX FAILED: a fourth tip slot was admitted on one booking';
  end if;
  raise notice 'count cap holds against reservations, not just charges';

  -- ══ B1. A refunded tip is reversed, and the reversal is idempotent ════════
  r1 := public.reserve_tip_slot(bid_b, 2000);
  if not public.confirm_tip_charge(r1->>'key', 'pi_tip_probe_refund') then
    raise exception 'could not stage a credited tip to reverse';
  end if;

  -- Bring this earner to exactly what the control expects, so the assertions below are
  -- about the tip and not about whatever real drift the profile already carried.
  select (detail->>'delta_dollars')::numeric into d0
    from public.ctl_earnings_total_drift() where entity_id = uid::text;
  if d0 is not null then
    update public.profiles set earnings_total = coalesce(earnings_total, 0) - d0 where id = uid;
  end if;
  if exists (select 1 from public.ctl_earnings_total_drift() where entity_id = uid::text) then
    raise exception 'could not bring the staged earner into balance — the rest proves nothing';
  end if;

  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  n1 := public.record_tip_reversal(
    'pi_tip_probe_refund', 2000,
    'Stripe refund on charge ch_probe (usd 20.00 refunded)');
  if n1 is distinct from 2000 then
    raise exception 'record_tip_reversal reversed % cents, expected 2000', n1;
  end if;
  select coalesce(earnings_total, 0) into e1 from public.profiles where id = uid;
  if e1 <> e0 - 20.00 then
    raise exception 'a refunded tip moved earnings by % instead of -20.00', e1 - e0;
  end if;
  -- The half the audit called REQUIRED, not optional: a correctly handled reversal must
  -- not become a false positive.
  if exists (select 1 from public.ctl_earnings_total_drift() where entity_id = uid::text) then
    raise exception 'FIX FAILED: a correctly handled tip reversal opened a drift finding';
  end if;

  -- Stripe redelivers events. Same cumulative target, so nothing more may move.
  n2 := public.record_tip_reversal(
    'pi_tip_probe_refund', 2000,
    'Stripe refund on charge ch_probe (usd 20.00 refunded)');
  if n2 is distinct from 0 then
    raise exception 'FIX FAILED: a redelivered reversal reversed % more cents', n2;
  end if;
  select coalesce(earnings_total, 0) into e2 from public.profiles where id = uid;
  if e2 <> e1 then
    raise exception 'FIX FAILED: a redelivered reversal moved earnings again (% -> %)', e1, e2;
  end if;
  raise notice 'cumulative-target semantics make redelivery a no-op by construction';

  -- ══ B2. THE LIE, on the same row ══════════════════════════════════════════
  -- Put the ledger back in the state the product is in TODAY: the tip is reversed at
  -- Stripe and nothing has taken it off the earner's in-app total.
  update public.profiles set earnings_total = coalesce(earnings_total, 0) + 20.00 where id = uid;
  select detail into det from public.ctl_earnings_total_drift() where entity_id = uid::text;
  if det is null then
    raise exception 'FIX FAILED: the control is silent on a 2000c overstatement';
  end if;
  if (det->>'tip_clawback_cents')::bigint <> 2000 then
    raise exception 'the control attributes %c of tip clawback, expected 2000c', det->>'tip_clawback_cents';
  end if;
  -- What the OLD body computed on this exact row: expected without the tip_clawed CTE.
  if (det->>'expected_earnings_total')::numeric + 20.00
     <> (det->>'stored_earnings_total')::numeric then
    raise exception 'probe is not discriminating: the old body would not have called this healthy';
  end if;
  raise notice 'discriminates: old body expected % against a stored % and reported healthy; new body reports % drift',
    (det->>'expected_earnings_total')::numeric + 20.00,
    (det->>'stored_earnings_total')::numeric,
    det->>'delta_dollars';

  -- ══ B3. A chargeback is absorbed, exactly as on the escrow leg ════════════
  r1 := public.reserve_tip_slot(bid_c, 1500);
  if not public.confirm_tip_charge(r1->>'key', 'pi_tip_probe_chargeback') then
    raise exception 'could not stage a credited tip for the chargeback arm';
  end if;
  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  n3 := public.record_tip_reversal(
    'pi_tip_probe_chargeback', 1500,
    'Stripe chargeback dp_probe (fraudulent, usd 15.00)');
  if n3 is distinct from 1500 then
    raise exception 'the chargeback arm reversed % cents, expected 1500', n3;
  end if;
  select coalesce(earnings_total, 0) into e1 from public.profiles where id = uid;
  if e1 <> e0 then
    raise exception 'FIX FAILED: a tip chargeback DEBITED the earner (% -> %) — 20260813160000 says the platform absorbs it', e0, e1;
  end if;
  select coalesce(reversed_cents, 0), coalesce(earner_reversed_cents, 0)
    into v_rev, v_earner_rev
    from public.tip_ledger where payment_intent_id = 'pi_tip_probe_chargeback';
  if v_rev <> 1500 or v_earner_rev <> 0 then
    raise exception 'chargeback recorded reversed=% earner_reversed=%, expected 1500 / 0', v_rev, v_earner_rev;
  end if;
  raise notice 'a charged-back tip is RECORDED (1500c) without a silent debit — the record exists, the number stays true';

  -- B4. A PaymentIntent that is not a tip must answer NULL, not 0.
  if public.record_tip_reversal('pi_definitely_not_a_tip', 100, 'Stripe refund on charge ch_x (usd 1.00 refunded)') is not null then
    raise exception 'record_tip_reversal claimed a PaymentIntent it does not hold';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'tip reservation + reversal probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
