-- ─────────────────────────────────────────────────────────────────────────────
-- Tip caps (2026-08-04).
--
-- WHY: tips were the one uncapped, fee-free, card-funded transfer channel in the
-- product. stripe-tip bounds a SINGLE call to 50¢–$1000, but nothing bounded the
-- total: its idempotency key is `tip_${bookingId}_${tipCents}`, so simply varying
-- the amount mints a fresh PaymentIntent every time, and tips carry NO
-- application_fee_amount (unlike stripe-create-payment-intent, which takes 10%) —
-- 100% routes to the earner's connected balance, which pays out daily with no
-- delay_days. A colluding poster/earner pair with one real $10 gig could move
-- arbitrary sums at a 0% take rate, every cent of it chargeback-eligible against
-- the PLATFORM balance 30–90 days later because these are destination charges.
--
-- Three caps, all enforced here as the authoritative backstop:
--   1. per-booking total   — max(2x what the job actually captured, $200)
--   2. per-booking count   — 3
--   3. per-poster velocity — $500 per rolling 24h
--
-- Cap 1 is deliberately relative: a generous tip on a $400 job is normal, a $5,000
-- tip on a $20 job is not. The $200 floor keeps small legitimate jobs tippable.
--
-- These are NOT exempted for service_role. Every other guard in this schema skips
-- service_role because the threat model is a hostile CLIENT, but tip_ledger is
-- written ONLY by claim_and_credit_tip() (SECURITY DEFINER, invoked by the edge
-- function with the service key). Exempting service_role here would make the
-- trigger a no-op.
--
-- stripe-tip pre-checks the same limits BEFORE creating the PaymentIntent, so an
-- over-cap tip is refused with a clean 409 and no card is touched. This trigger is
-- the backstop for any other write path; if it ever fires in production it means
-- the card was already charged, so it raises a distinctly-tagged error the
-- operator can search for.
-- ─────────────────────────────────────────────────────────────────────────────

-- Supporting indexes. The guard sums per booking and per poster/24h on every tip,
-- and tip_ledger had no index but its PK and the payment_intent_id unique.
create index if not exists tip_ledger_booking_idx on public.tip_ledger (booking_id);
create index if not exists tip_ledger_created_idx on public.tip_ledger (created_at desc);

create or replace function public.guard_tip_caps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  -- claim_and_credit_tip() does `insert ... on conflict (payment_intent_id) do
  -- nothing`, and in PostgreSQL a BEFORE INSERT row trigger fires BEFORE conflict
  -- arbitration. So on a legitimate retry (Stripe idempotent replay, or the
  -- deliberate re-call that credits a ledger row inserted-but-not-yet-credited)
  -- this guard would run again and count the ALREADY-STORED row as if it were a
  -- second tip — rejecting a $150 tip on its own retry and aborting the whole
  -- credit transaction. That would break the exactly-once mechanism the ledger
  -- exists to provide, and strand a charged tip uncredited: precisely the failure
  -- the caps are meant to prevent.
  --
  -- A row with this payment_intent_id already existing means this is not new money.
  if exists (
    select 1 from public.tip_ledger where payment_intent_id = new.payment_intent_id
  ) then
    return new;
  end if;

  -- SERIALISE BEFORE READING.
  --
  -- Every cap below is a read-then-decide over rows another transaction may be
  -- inserting concurrently. Under READ COMMITTED (what PostgREST uses) an
  -- uncommitted tip_ledger row is invisible, so N parallel tips would each read an
  -- empty ledger and each conclude they were the first — and because the
  -- idempotency key in stripe-tip is `tip_${bookingId}_${tipCents}`, an attacker
  -- only has to vary the amount by a cent to get N distinct PaymentIntents that
  -- never collide. Six parallel $1000 tips on a $20 booking would all pass a $200
  -- cap. That is precisely the colluding pair this migration exists to stop, so an
  -- unlocked check is not a cap at all.
  --
  -- The row lock claim_and_credit_tip takes on `bookings` comes AFTER this trigger
  -- has already decided, so it cannot serialise us. Advisory locks are held for the
  -- rest of the transaction and released automatically on commit/rollback.
  --
  -- Resolve the poster FIRST and always take poster-lock then booking-lock, in that
  -- fixed order, so two concurrent tips can never grab them in opposite orders and
  -- deadlock.
  select j.poster_id
    into v_poster
    from public.bookings b
    join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  if v_poster is not null then
    perform pg_advisory_xact_lock(hashtextextended('gohustlr.tip.poster:' || v_poster::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gohustlr.tip.booking:' || new.booking_id::text, 0));

  -- What this booking actually collected. amount_cents is the original
  -- AUTHORIZATION and is never rewritten, so the captured total is the split:
  -- earner_amount_cents + fee_cents (see stripe-capture-payment).
  select coalesce(sum(coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0)), 0)
    into v_captured_cents
    from public.payments p
   where p.booking_id = new.booking_id
     and p.status = 'captured';

  select coalesce(sum(t.amount_cents), 0), count(*)
    into v_existing_cents, v_existing_count
    from public.tip_ledger t
   where t.booking_id = new.booking_id;

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
  -- per-booking cap alone is evaded by spreading the same money over many small
  -- fake gigs, which is the shape laundering actually takes.
  -- (v_poster was resolved above, before the locks.)
  if v_poster is not null then
    select coalesce(sum(t.amount_cents), 0)
      into v_poster_24h
      from public.tip_ledger t
      join public.bookings b on b.id = t.booking_id
      join public.jobs j on j.id = b.job_id
     where j.poster_id = v_poster
       and t.created_at >= now() - interval '24 hours';

    if v_poster_24h + new.amount_cents > 50000 then
      raise exception 'tip_cap_velocity'
        using errcode = 'check_violation',
              hint = 'You have reached the daily tipping limit. Try again tomorrow.';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_tip_caps() from public, anon, authenticated;

drop trigger if exists trg_guard_tip_caps on public.tip_ledger;
create trigger trg_guard_tip_caps
  before insert on public.tip_ledger
  for each row execute function public.guard_tip_caps();

-- Read-only helper the edge function calls BEFORE charging the card, so the cap is
-- enforced without money moving first. Returns the remaining headroom in cents
-- (0 when any cap is already reached) plus the reason, so the client can show
-- honest copy instead of a generic failure. Mirrors the trigger exactly — change
-- both together.
create or replace function public.tip_headroom_cents(p_booking uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
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
   where t.booking_id = p_booking;

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
       and t.created_at >= now() - interval '24 hours';

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
$$;

-- Only the edge function (service role) may ask. Exposing this to `authenticated`
-- would turn it into a probe for other people's tip history via a booking id.
revoke execute on function public.tip_headroom_cents(uuid) from public, anon, authenticated;
grant execute on function public.tip_headroom_cents(uuid) to service_role;
