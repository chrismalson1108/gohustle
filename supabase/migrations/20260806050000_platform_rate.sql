-- ─────────────────────────────────────────────────────────────────────────────
-- The platform take rate becomes data, and is pinned per booking (2026-08-06).
--
-- WHAT THIS REPLACES
--
-- The 10% lived as a literal in SEVEN places across THREE deploy targets: the four
-- edge functions that touch money (stripe-create-payment-intent:132,
-- stripe-capture-payment:118 and :146, earner-claim-payment:225, assistant:1156),
-- both client display constants (src/lib/stripeClient.js:7, web/lib/config.ts:19),
-- and prose in three components. Changing the rate meant an App Store release, a
-- Vercel deploy and an edge deploy, all landing together or drifting apart.
--
-- THE INVARIANT THAT SURVIVES
--
-- stripe-capture-payment deliberately recomputes the fee from amount_cents rather
-- than reading the mutable fee_cents column, and the comment at :111-117 explains
-- why: fee_cents is rewritten on a partial capture, so a retry after a Stripe timeout
-- would scale an already-reduced value again (fee * pct^2), under-collecting for the
-- platform and over-crediting the earner. Deriving from an IMMUTABLE input is what
-- makes the operation idempotent.
--
-- So the rate does not become a global that capture reads at capture time — that
-- would let a booking authorized at 10% capture at whatever the rate is now, and a
-- poster quoted one number would be charged another on work already agreed. Instead
-- the RATE ITSELF becomes a second immutable input: bookings.fee_bps_quoted is
-- stamped at INSERT beside amount_cents_quoted, payments.fee_bps inherits it at
-- authorization, and every downstream site derives from (amount_cents, fee_bps).
-- Two frozen values in, idempotency intact, rate pinned to the deal.
--
-- BASIS POINTS, NOT A FLOAT. 1000 = 10.00%. Money rates in floating point accumulate
-- representation error and invite 0.1-vs-10 unit confusion; an integer cannot.
--
-- FAIL CLOSED. Every degradation path lands on 1000 bps — the rate every shipped
-- build already displays and every existing payments row already reflects. Both new
-- columns are NOT NULL DEFAULT 1000, which backfills history correctly. fee_bps_at()
-- clamps to [500, 3000] and coalesces a missing row to 1000, so an empty table, a
-- deleted row or a NULL cannot produce a zero fee. A revenue outage caused by the
-- config system is strictly worse than the config system not existing.
--
-- This migration is a NO-OP on behaviour: it seeds 1000 bps effective from the epoch,
-- so every computation yields exactly what the hardcoded 0.10 yields today. The edge
-- functions start reading it in a following deploy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Effective-dated rate card ────────────────────────────────────────────────
-- Append-only by intent: to change the rate you insert a row with a future
-- effective_from, which leaves a permanent record of what was true when. Nothing
-- updates or deletes, so "what rate applied on the 3rd?" is always answerable.
create table if not exists public.platform_rates (
  id             uuid primary key default gen_random_uuid(),
  fee_bps        integer not null check (fee_bps between 500 and 3000),
  effective_from timestamptz not null,
  note           text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);

create unique index if not exists platform_rates_effective_uniq
  on public.platform_rates (effective_from);

alter table public.platform_rates enable row level security;
revoke all on public.platform_rates from anon, authenticated;
grant all  on public.platform_rates to service_role;

comment on table public.platform_rates is
  'Effective-dated platform take rate in basis points. Append-only: change the rate '
  'by inserting a future-dated row. Never UPDATE — history is the point.';

-- Seed today's rate, effective from the epoch so every historical booking resolves.
insert into public.platform_rates (fee_bps, effective_from, note)
select 1000, '1970-01-01T00:00:00Z'::timestamptz,
       'Founding rate: 10%. Seeded by 20260806050000; matches the hardcoded 0.10 it replaces.'
where not exists (select 1 from public.platform_rates);

-- ── Reader ───────────────────────────────────────────────────────────────────
-- The rate in force at a moment. Clamped and defaulted so no data state can yield
-- a zero or absurd fee.
create or replace function public.fee_bps_at(p_at timestamptz default now())
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(500, least(3000, coalesce(
    (select r.fee_bps from public.platform_rates r
      where r.effective_from <= coalesce(p_at, now())
      order by r.effective_from desc
      limit 1),
    1000)))
$$;

revoke execute on function public.fee_bps_at(timestamptz) from public, anon;
-- authenticated may READ the current rate: the clients need it to render the fee
-- breakdown. It is disclosure, not a secret. They still never supply it.
grant execute on function public.fee_bps_at(timestamptz) to authenticated, service_role;

-- ── The floor that makes a 0% promotion safe ─────────────────────────────────
-- Stripe's own cost on a card charge is ~2.9% + 30c, plus we keep a 25c margin so a
-- fee-free gig is never settled at a loss. This does four jobs at once:
--   * a 0-bps promotion still covers processing, so "free" cannot cost us money
--   * application_fee_amount is never zero, so Stripe's reject-zero-fee edge case
--     and admin-payment-action's unconditional refund_application_fee both keep working
--   * self-dealing (post a gig, book it from an alt, verify, withdraw) costs ~3.2%
--     instead of being a free money-laundering rail
--   * the floor is never allowed to exceed the amount itself
create or replace function public.platform_fee_cents(p_amount_cents integer, p_fee_bps integer)
returns integer
language sql
immutable
as $$
  select greatest(0, least(
    coalesce(p_amount_cents, 0),
    greatest(
      -- ROUND HALF UP, matching Math.round in the JS this replaces. The obvious
      -- (amount * bps) / 10000 truncates, and on a $10.05 gig at 10% that is 100c
      -- where every shipped client says 101c. A one-cent disagreement between the
      -- SQL and the code it is replacing would defeat the whole purpose, and it
      -- would only ever show up on odd amounts in production.
      (coalesce(p_amount_cents, 0) * coalesce(p_fee_bps, 1000) + 5000) / 10000,
      ceil(coalesce(p_amount_cents, 0) * 0.029)::integer + 30 + 25
    )
  ))
$$;

comment on function public.platform_fee_cents(integer, integer) is
  'Fee in cents for an amount at a rate. Rounds half up to match Math.round in the '
  'JS it replaces, floors at Stripe cost (~2.9% + 30c) + 25c margin, caps at the amount.';

-- ── Pin the rate on the booking, beside the amount ───────────────────────────
alter table public.bookings
  add column if not exists fee_bps_quoted integer not null default 1000;

comment on column public.bookings.fee_bps_quoted is
  'Take rate in basis points frozen at INSERT. What the parties agreed to; capture '
  'derives from this and amount_cents_quoted, never from the live rate.';

-- Extends 20260806000000''s trigger: same reasoning, second frozen input. Reproduced
-- in full because create or replace needs the whole body.
create or replace function public.pin_booking_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j record;
begin
  if tg_op = 'INSERT' then
    select pay, pay_type, estimated_hours into j
      from public.jobs where id = new.job_id;

    if not found or j.pay is null then
      return new;
    end if;

    new.amount_cents_quoted := round(
      coalesce(new.counter_offer, j.pay)
      * (case when j.pay_type = 'hourly' then coalesce(j.estimated_hours, 1) else 1 end)
      * 100
    )::integer;

    -- The rate in force at the moment the earner committed. A later rate change
    -- cannot reach back and re-price this booking.
    new.fee_bps_quoted := public.fee_bps_at(now());

    return new;
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.amount_cents_quoted := old.amount_cents_quoted;
    new.fee_bps_quoted      := old.fee_bps_quoted;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_booking_amount() from public, anon, authenticated;

-- ── Carry the rate onto the payment ──────────────────────────────────────────
alter table public.payments
  add column if not exists fee_bps integer not null default 1000;

comment on column public.payments.fee_bps is
  'Rate this authorization was struck at, copied from bookings.fee_bps_quoted. '
  'Capture and claim derive the fee from (amount_cents, fee_bps) — both immutable — '
  'which is what keeps a partial-capture retry idempotent.';

-- payments is service-role-only (update revoked from anon+authenticated in
-- 20260804010000), so this trigger exists to guarantee the value is CORRECT rather
-- than to defend against a client: an edge function that forgets to send fee_bps
-- would otherwise silently inherit the 1000 default even on a promoted booking.
create or replace function public.pin_payment_fee_bps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    select coalesce(b.fee_bps_quoted, 1000) into new.fee_bps
      from public.bookings b where b.id = new.booking_id;
    new.fee_bps := coalesce(new.fee_bps, 1000);
  else
    -- Immutable once authorized. The whole point is that it cannot move.
    new.fee_bps := old.fee_bps;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_payment_fee_bps() from public, anon, authenticated;

drop trigger if exists trg_z_pin_payment_fee_bps on public.payments;
create trigger trg_z_pin_payment_fee_bps
  before insert or update on public.payments
  for each row execute function public.pin_payment_fee_bps();
