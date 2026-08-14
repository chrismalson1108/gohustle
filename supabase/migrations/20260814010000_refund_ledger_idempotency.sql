-- ─────────────────────────────────────────────────────────────────────────────
-- The refund's idempotency key protects Stripe. Nothing protected the ledger.
--
-- admin-payment-action passes Stripe an idempotency key
-- (`refund_${pi}_${alreadyRefunded + refundCents}`) derived from a value it read
-- BEFORE the call. If the first invocation's `record_refund` has not committed when the
-- operator retries — and InterventionPanel makes that easy, because it clears the form
-- only on success, so after the 20s AbortSignal.timeout the reason and amount are still
-- sitting there and the retry sends byte-identical FormData — then:
--
--   • the retry reads refunded_cents = 0, rebuilds the SAME key
--   • Stripe REPLAYS: it returns the original Refund object, no new money moves
--   • the code never inspects refund.id to notice it received a replay
--   • record_refund runs a second time: refunded_cents = 2X, debit_earnings twice
--
-- One refund left Stripe; the ledger records two. Both parties' receipts print the
-- doubled figure (PaymentsScreen "Refunded to you − $60.00", the CSV export) and the
-- earner's earnings_total is debited twice. ctl_earnings_total_drift cannot see it: it
-- reconstructs the expected clawback FROM refunded_cents, so a doubled refund and a
-- doubled debit agree with each other.
--
-- Damage is bounded at 50% by record_refund's own cap (a second full refund returns
-- null → 409 ledger_desync), which is why this is medium and not critical. It is also
-- reachable today: the console refund path is live and admin-tier.
--
-- ── THE FIX, WHICH THIS REPO ALREADY WROTE ONE FUNCTION OVER ────────────────
--
-- stripe-tip has exactly this problem and solved it: `tip_ledger` with a UNIQUE index
-- on payment_intent_id, and `claim_and_credit_tip` whose INSERT … ON CONFLICT is what
-- makes a Stripe replay a no-op — a conflict, not a read-then-decide. Refunds get the
-- same shape, keyed on Stripe's `refund.id`, which is the one value that is genuinely
-- different between a real second refund and a replay of the first.
--
-- The manual chargeback path has no Stripe object at all, so it gets a deterministic
-- key from what an accidental resubmit repeats: the PaymentIntent and the amount. A
-- genuinely different second reversal carries a different amount; an operator's
-- double-click does not. Deliberately NOT including the reason text — keying on it
-- would let a retyped word through, which is the whole failure mode.
--
-- ── AND: refund_source stops being permanent ────────────────────────────────
--
-- The same column is stamped 'admin' before the Stripe call and never cleared, by
-- anything, anywhere. It exists to tell stripe-webhook's recordReversal "this refund is
-- an in-flight remediation, do not file a fresh disputes row against it" — a statement
-- about ONE action, stored in a flag that outlives it. So after any console refund, a
-- later EXTERNAL refund on the same payment also files no disputes row, and
-- ctl_external_reversal_not_ledgered / dispute_open_beyond_sla / the /disputes queue
-- never learn about it. (The chargeback half of this was fixed on 2026-08-13 by scoping
-- the exemption to kind === 'refund'; this is the refund half.)
--
-- record_refund now clears it as part of ledgering the refund it was marking, so the
-- marker lasts exactly as long as the action it describes. Nothing is lost from the
-- audit trail: refund_ledger records kind and recorded_by per reversal, which is
-- strictly more than one sticky column ever said.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.refund_ledger (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments(id) on delete cascade,
  -- Stripe's refund id, or `chargeback_<pi>_<cents>` for a ledger-only reversal.
  -- UNIQUE is the guard: the conflict IS the idempotency check.
  external_id text not null unique,
  kind        text not null check (kind in ('refund', 'chargeback')),
  cents       integer not null check (cents > 0),
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists refund_ledger_payment_idx on public.refund_ledger (payment_id);

-- Service-role only, like tip_ledger: RLS on with no policies at all. The edge
-- functions write it; no client has any business reading it directly.
alter table public.refund_ledger enable row level security;
revoke all on public.refund_ledger from public, anon, authenticated;

-- Adding a defaulted parameter to the existing 5-arg form would make every 5-arg call
-- ambiguous ("function is not unique") rather than picking one — the same trap
-- 20260813140000 hit with promo_benefit_cents. Drop first.
drop function if exists public.record_refund(uuid, integer, text, uuid, boolean);

create or replace function public.record_refund(
  p_payment_id   uuid,
  p_cents        integer,
  p_reason       text,
  p_admin        uuid,
  p_debit_earner boolean default true,
  -- Stripe's refund.id, or the manual key above. NULL keeps the pre-existing
  -- behaviour (no dedupe) so an un-migrated caller still works — but every caller in
  -- this repo passes one, and __tests__/refundIdempotency.test.js fails if that stops
  -- being true.
  p_external_id  text default null
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
  -- FOR UPDATE serialises concurrent refunds on this payment. It makes the second call
  -- add cleanly on top of the first; it has never deduplicated them.
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

  -- Claim this specific reversal. Deliberately AFTER the cap check, so a refund that
  -- was refused never leaves a ledger row that would make a corrected retry look like
  -- a replay.
  if p_external_id is not null then
    insert into public.refund_ledger (payment_id, external_id, kind, cents, recorded_by)
    values (
      p_payment_id,
      p_external_id,
      case when p_debit_earner then 'refund' else 'chargeback' end,
      p_cents,
      p_admin
    )
    on conflict (external_id) do nothing;

    if not found then
      -- Already recorded. Return the CURRENT total, not null: the caller must report
      -- success for work that is genuinely done, or an operator retries again.
      return v_already;
    end if;
  end if;

  v_new := v_already + p_cents;
  update public.payments
     set refunded_cents = v_new,
         refunded_at    = now(),
         refund_reason  = p_reason,
         refunded_by    = p_admin,
         -- The in-flight marker has done its job the moment this refund is ledgered.
         -- Leaving it set is what silenced later external reversals on this payment.
         refund_source  = null
   where id = p_payment_id;

  -- ONLY when the money was actually recovered from the earner. A chargeback on a
  -- destination charge hits the platform balance and leaves the transfer alone, so
  -- there is nothing to debit and debiting anyway only falsifies the earner's own
  -- record of what they were paid.
  if p_debit_earner then
    select round(p_cents::numeric * coalesce(earner_amount_cents, 0) / nullif(v_captured, 0))::integer
      into v_earner_share
      from public.payments where id = p_payment_id;

    perform public.debit_earnings(p_payment_id, v_earner_share);
  end if;

  return v_new;
end;
$function$;

revoke execute on function public.record_refund(uuid, integer, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, integer, text, uuid, boolean, text) to service_role;

-- ── Prove it DISCRIMINATES: replay vs genuine second refund, same staged row ─
do $$
declare
  bid uuid; pid uuid; jid uuid; uid uuid;
  t1 integer; t2 integer; t3 integer;
  e0 numeric; e1 numeric; e2 numeric;
  v_src text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- `deleted_at is null`, and it is load-bearing: 20260813150000 made account deletion a
  -- TOMBSTONE, and a scrubbed profile's guard refuses the seeding UPDATE below. The
  -- probe then read an unchanged balance, debit_earnings floored at 0, and the whole
  -- thing failed as "not discriminating" — which is a true statement about the wrong
  -- cause. Same filter yesterday's chargeback probe used.
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then
    raise exception 'no live profile to stage against';
  end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'refund idem probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status)
  values (jid, uid, 'verified') returning id into bid;
  -- $60 captured: earner 5580 + fee 420.
  -- earnings_credited MUST be true: debit_earnings returns false outright when it is
  -- not, on purpose — refunding a capture whose credit failed would debit an earner for
  -- money they never received. A probe that omits it sees no debit and misreports that
  -- as the fix failing to discriminate.
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, refund_source, earnings_credited)
  values (bid, 'pi_refund_idem_probe', 6000, 420, 5580, 0, 'captured', now(), 'admin', true)
  returning id into pid;

  -- The earner must have a balance or debit_earnings floors at 0 and the probe passes
  -- vacuously — the same trap the chargeback probe hit yesterday.
  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  update public.profiles set earnings_total = e0 + 500 where id = uid;
  select coalesce(earnings_total, 0) into e0 from public.profiles where id = uid;
  -- Assert the SEEDING worked before assigning any meaning to what follows. Without
  -- this, a refused write is indistinguishable from a fix that does not discriminate,
  -- and the error names the wrong thing.
  if e0 < 500 then
    raise exception 'could not seed a balance on profile % (guard refused the write?) — probe cannot discriminate', uid;
  end if;

  -- First refund: $30 of a $60 capture, keyed on a Stripe refund id.
  t1 := public.record_refund(pid, 3000, 'probe refund', uid, true, 're_probe_AAA');
  select earnings_total into e1 from public.profiles where id = uid;

  -- THE REPLAY: identical parameters, identical Stripe refund id. Stripe returned the
  -- same Refund object; no second refund exists.
  t2 := public.record_refund(pid, 3000, 'probe refund', uid, true, 're_probe_AAA');
  select earnings_total into e2 from public.profiles where id = uid;

  if t1 <> 3000 then
    raise exception 'FIRST REFUND WRONG: expected refunded_cents 3000, got %', t1;
  end if;
  if t2 <> 3000 then
    raise exception 'REPLAY DOUBLE-COUNTED: refunded_cents moved to % on a replayed refund id', t2;
  end if;
  if e1 = e0 then
    raise exception 'probe is not discriminating: the first refund debited nothing';
  end if;
  if e2 <> e1 then
    raise exception 'REPLAY DEBITED AGAIN: earnings went % -> % on a replayed refund id', e1, e2;
  end if;
  raise notice 'replay is a no-op: refunded_cents % -> %, earnings % -> %', t1, t2, e1, e2;

  -- A GENUINE second refund — different Stripe refund id — must still go through.
  t3 := public.record_refund(pid, 1000, 'second probe refund', uid, true, 're_probe_BBB');
  if t3 <> 4000 then
    raise exception 'OVER-CORRECTED: a genuine second refund was swallowed (got %)', t3;
  end if;
  raise notice 'a genuine second refund still records: %', t3;

  -- And the in-flight marker is cleared, so a later external reversal is visible.
  select refund_source into v_src from public.payments where id = pid;
  if v_src is not null then
    raise exception 'refund_source still set to % after ledgering — later external reversals stay invisible', v_src;
  end if;
  raise notice 'refund_source cleared once the refund was ledgered';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'refund idempotency probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
