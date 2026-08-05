-- ─────────────────────────────────────────────────────────────────────────────
-- Refund-path corrections (2026-08-04), from the adversarial review of the Phase 1
-- change set. Three real defects in brand-new money code, plus one regression.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. A refund must reverse the earner's in-app earnings ────────────────────
-- admin-payment-action issues the Stripe refund with reverse_transfer:true, which
-- pulls the earner's net back out of their connected balance — but it wrote only
-- payments.refunded_cents. profiles.earnings_today/week/total were incremented at
-- capture by credit_earnings and NOTHING in the entire repo ever decremented them:
-- every writer is an increment. So after a refund the platform's GMV dropped while
-- the earner's own "Total earned" kept the money forever, and the two ledgers
-- disagreed permanently by the value of every refund issued.
--
-- Mirrors credit_earnings exactly, including the roll_earnings_period call — without
-- it a debit lands on a stale day/week bucket and can drive a fresh period negative.
-- Floored at 0: a refund spanning a period boundary can legitimately exceed what the
-- current today/week bucket holds, and a negative "earned this week" is worse than a
-- slightly generous one.
create or replace function public.debit_earnings(p_payment_id uuid, p_cents integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_earner  uuid;
  v_dollars numeric;
  v_credited boolean;
begin
  if p_cents is null or p_cents <= 0 then
    return false;
  end if;

  select coalesce(p.earnings_credited, false), b.earner_id
    into v_credited, v_earner
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.id = p_payment_id;

  -- Nothing was ever credited for this payment, so there is nothing to take back.
  -- Guards against a refund on a capture whose credit failed, which would otherwise
  -- debit an earner for money they never received.
  if not coalesce(v_credited, false) or v_earner is null then
    return false;
  end if;

  perform public.roll_earnings_period(v_earner);

  v_dollars := p_cents::numeric / 100;
  update public.profiles
     set earnings_today = greatest(0, coalesce(earnings_today, 0) - v_dollars),
         earnings_week  = greatest(0, coalesce(earnings_week,  0) - v_dollars),
         earnings_total = greatest(0, coalesce(earnings_total, 0) - v_dollars)
   where id = v_earner;
  return true;
end;
$$;

revoke execute on function public.debit_earnings(uuid, integer) from public, anon, authenticated;
grant execute on function public.debit_earnings(uuid, integer) to service_role;


-- ── 2. Record a refund atomically, without the read-modify-write race ────────
-- The edge function read refunded_cents, added to it, and wrote the absolute total
-- back with only .eq('id', …). Two concurrent refunds (or one double-submit with a
-- changed amount) both computed from the same stale base, so the second silently
-- overwrote the first and the ledger under-reported what Stripe actually returned.
--
-- This does the addition IN SQL under the row lock, re-checks the cap against the
-- captured total, and debits the earner in the SAME transaction — so the ledger and
-- the earnings can no longer disagree.
--
-- Returns the new total, or null when the increment would exceed what was collected
-- (the caller turns that into a 409 rather than a silent clamp).
create or replace function public.record_refund(
  p_payment_id uuid,
  p_cents      integer,
  p_reason     text,
  p_admin      uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  -- The earner only ever received their share, not the platform fee, so only their
  -- share comes back off their ledger. Proportional to how much of the capture is
  -- being refunded.
  select round(p_cents::numeric * coalesce(earner_amount_cents, 0) / nullif(v_captured, 0))::integer
    into v_earner_share
    from public.payments where id = p_payment_id;

  perform public.debit_earnings(p_payment_id, v_earner_share);
  return v_new;
end;
$$;

revoke execute on function public.record_refund(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, integer, text, uuid) to service_role;


-- ── 3. A console refund must not file a dispute against its own booking ──────
-- stripe-webhook's charge.refunded handler calls recordReversal(), which inserts a
-- disputes row with resolved_at NULL. Every refund issued from the console fires
-- that webhook — so remediating a booking immediately filed a NEW open dispute
-- against it, which earner-claim-payment then treats as a reason to refuse
-- settlement. The console's own fix re-blocked the thing it had just fixed.
--
-- A marker column is the cleanest signal available: the webhook arrives out of band
-- with only the charge, and it cannot otherwise tell an operator-initiated refund
-- from a customer-initiated one.
alter table public.payments add column if not exists refund_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_refund_source_check') then
    alter table public.payments add constraint payments_refund_source_check
      check (refund_source is null or refund_source in ('admin', 'stripe', 'chargeback'));
  end if;
end $$;


-- ── 4. Attribution columns must not make an admin undeletable ────────────────
-- 20260705020000_admin_audit_fk_fix.sql exists solely because `references
-- auth.users(id)` on an attribution column makes a former admin's account
-- impossible to delete — it dropped exactly these FKs from admin_audit_log and
-- admin_user_notes. Phase 1 then added four more of the same. Keep the uuid as bare
-- attribution, matching the pattern that migration established.
alter table public.app_flags drop constraint if exists app_flags_updated_by_fkey;
alter table public.disputes  drop constraint if exists disputes_assigned_to_fkey;
alter table public.disputes  drop constraint if exists disputes_resolved_by_fkey;
alter table public.payments  drop constraint if exists payments_refunded_by_fkey;
