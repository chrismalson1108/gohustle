-- ─────────────────────────────────────────────────────────────────────────────
-- A partial capture consumed the earner's whole referral credit and delivered part of it.
--
-- consume_fee_credit debits the credit at BOOKING, sized to the fee on the full gig. If
-- the booking is later settled below 100% — a dispute resolved at 50% — the fee shrinks,
-- so the credit can only offset a smaller amount. The rest is simply gone: the ledger row
-- is 'applied', release_booking_benefits early-returns once captured, and its only trigger
-- fires solely on declined/cancelled.
--
-- Measured against live pg_proc, a $200 gig with a 765c credit settled at 50%:
--
--   fee at 50% WITHOUT the credit   700c
--   fee at 50% WITH the credit      345c
--   value the credit delivered      355c
--   value consumed                  765c   →  410c destroyed, more than half
--
-- ── WHY RETURN IT RATHER THAN CALL IT SPENT ─────────────────────────────────
--
-- Two reasons, and neither is sentiment.
--
-- 1. The platform ALREADY does this for the other benefit. settle_booking_benefits
--    relaxes a promotion's budget on exactly this event — "now that the real figure is
--    known, give the difference back". It iterates promo_redemptions only, so referral
--    credits were left out of a rule the system already follows. That is an omission,
--    not a decision.
--
-- 2. consume_fee_credit already refuses to forfeit. When a credit is only partially
--    usable it SPLITS the row and leaves the remainder payable, with the comment
--    "splitting rather than forfeiting is the difference between a credit and a coupon".
--    This is the same situation one step later in time; the same answer applies.
--
-- And the timing matters: a partial capture is a dispute. The earner is already being
-- paid less, for something the POSTER initiated. Silently eating a bonus they spent seven
-- days vesting is the worst available moment to take it.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────────
--
-- Mirror of consume: walk this booking's applied rows newest-first and hand back exactly
-- the undelivered amount, splitting the last row if it straddles the boundary. Never
-- returns more than was applied, and is idempotent on the delivered figure — the caller
-- passes what the credit ACHIEVED, so a retry with the same number is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.return_unused_fee_credit(
  p_booking         uuid,
  p_delivered_cents integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  applied_total integer;
  unused        integer;
  given_back    integer := 0;
  r             record;
begin
  if p_booking is null then return 0; end if;

  select coalesce(sum(amount_cents), 0) into applied_total
    from public.bonus_ledger
   where applied_booking_id = p_booking and state = 'applied' and delivery = 'credit';

  if applied_total <= 0 then return 0; end if;

  unused := applied_total - greatest(0, coalesce(p_delivered_cents, 0));
  if unused <= 0 then return 0; end if;

  for r in
    select id, amount_cents, user_id, promotion_id, reason, delivery, source_booking_id
      from public.bonus_ledger
     where applied_booking_id = p_booking and state = 'applied' and delivery = 'credit'
     order by created_at desc
     for update
  loop
    exit when given_back >= unused;

    if r.amount_cents <= unused - given_back then
      -- Whole row goes back to payable and detaches from the booking.
      update public.bonus_ledger
         set state = 'payable', applied_at = null, applied_booking_id = null
       where id = r.id;
      given_back := given_back + r.amount_cents;
    else
      -- Straddles the boundary: shrink the applied row to what was actually delivered
      -- and mint a payable row for the remainder. Same split consume_fee_credit does.
      update public.bonus_ledger
         set amount_cents = amount_cents - (unused - given_back)
       where id = r.id;
      insert into public.bonus_ledger
        (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id)
      values (r.user_id, r.promotion_id, r.reason, unused - given_back, r.delivery,
              'payable', r.source_booking_id);
      given_back := unused;
    end if;
  end loop;

  return given_back;
end;
$$;

revoke execute on function public.return_unused_fee_credit(uuid, integer) from public, anon, authenticated;
grant execute on function public.return_unused_fee_credit(uuid, integer) to service_role;

-- ── Prove it, on a staged booking, then roll the data back ──────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; back integer; payable_after integer; applied_after integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles limit 1;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'credit probe', 'Odd Jobs', 200, 'flat', 'Probe', 'probe', 'cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified') returning id into bid;

  -- 765c consumed on this booking; the capture only delivered 355c of it.
  insert into public.bonus_ledger (user_id, reason, amount_cents, delivery, state, applied_at, applied_booking_id)
  values (uid, 'probe', 765, 'credit', 'applied', now(), bid);

  select public.return_unused_fee_credit(bid, 355) into back;
  if back <> 410 then
    raise exception 'expected 410c returned, got %', back;
  end if;

  select coalesce(sum(amount_cents),0) into payable_after
    from public.bonus_ledger where user_id = uid and state = 'payable' and reason = 'probe';
  select coalesce(sum(amount_cents),0) into applied_after
    from public.bonus_ledger where applied_booking_id = bid and state = 'applied';
  if payable_after <> 410 or applied_after <> 355 then
    raise exception 'split wrong: payable=% applied=% (want 410/355)', payable_after, applied_after;
  end if;
  raise notice 'returned 410c, left 355c applied — the delivered value stays spent';

  -- Idempotent: running again with the same delivered figure must return nothing.
  select public.return_unused_fee_credit(bid, 355) into back;
  if back <> 0 then
    raise exception 'not idempotent: a second call returned %', back;
  end if;
  raise notice 'idempotent on retry';

  -- And a FULL capture (credit fully delivered) must return nothing.
  select public.return_unused_fee_credit(bid, 355) into back;
  if back <> 0 then raise exception 'over-returned on a fully-delivered credit'; end if;

  delete from public.bonus_ledger where user_id = uid and reason = 'probe';
  delete from public.bookings where id = bid;
  delete from public.jobs where id = jid;
end $$;
