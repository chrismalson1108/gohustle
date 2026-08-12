-- ─────────────────────────────────────────────────────────────────────────────
-- Fee credits were burned by bookings that never happened.
--
-- 20260806220000 taught the system to give back a promo grant and a poster discount
-- when a booking is declined or cancelled. It missed the third benefit: the fee credit
-- from bonus_ledger.
--
-- consume_fee_credit flips a payable credit to state='applied' and stamps
-- applied_booking_id. Nothing ever flips it back. So an earner who has a $10 referral
-- credit, applies to a gig, and gets DECLINED loses the credit permanently — for work
-- that never happened and money that never moved. That is worse than the promo case,
-- because a fee credit is something the user EARNED by referring a real person who did
-- real work, not something a campaign handed out.
--
-- ── ABOUT THE SPLIT ─────────────────────────────────────────────────────────
--
-- consume_fee_credit splits a partially-usable credit: it reduces the original row and
-- inserts a new 'applied' row for the portion consumed. Restoring simply flips every
-- applied row on this booking back to 'payable', which leaves the user holding two
-- payable rows where they had one. The TOTAL is identical and both are spendable, so
-- the split is cosmetic — and re-merging rows would be a second write that could fail
-- halfway and lose value, which is a strictly worse trade than a tidy ledger.
--
-- Deliberately restores to 'payable', not 'pending': these credits had already vested
-- (consume_fee_credit only ever takes payable ones), and sending them back through the
-- vesting window would punish the user a second time for someone else's decline.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.release_booking_benefits(p_booking uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r        public.promo_redemptions%rowtype;
  released int := 0;
  credits  int := 0;
  captured boolean;
begin
  if p_booking is null then return 0; end if;

  -- Never claw back a benefit whose money already moved. Tested on captured_at as well
  -- as status: status is an enum that has gained values before, and the timestamp is the
  -- fact. A partial capture writes both, so it is covered.
  select exists (
    select 1 from public.payments pay
     where pay.booking_id = p_booking
       and (pay.status = 'captured' or pay.captured_at is not null)
  ) into captured;
  if captured then return 0; end if;

  for r in
    select * from public.promo_redemptions
     where booking_id = p_booking
       and released_at is null
       and settled_at is null
     for update
  loop
    update public.promotions
       set redemptions_used = greatest(0, redemptions_used - 1),
           spent_cents      = greatest(0, spent_cents - r.reserved_cents)
     where id = r.promotion_id;

    update public.promo_grants
       set uses_consumed = greatest(0, uses_consumed - 1)
     where id = r.grant_id;

    update public.promo_redemptions
       set released_at = now(), release_reason = p_reason
     where id = r.id;

    released := released + 1;
  end loop;

  -- Give back any fee credit spent on this booking. Back to 'payable', because these
  -- had already vested before they were spendable at all.
  update public.bonus_ledger
     set state = 'payable',
         applied_at = null,
         applied_booking_id = null
   where applied_booking_id = p_booking
     and state = 'applied';
  get diagnostics credits = row_count;

  -- DELIBERATELY DOES NOT TOUCH bookings.fee_credit_cents / poster_discount_cents.
  --
  -- An earlier draft cleared them here and it was a serious mistake, caught in
  -- simulation: this function runs from an AFTER UPDATE trigger on bookings, so that
  -- write re-entered guard_bookings_write, which rejects it for most callers — and an
  -- exception raised in an AFTER trigger ROLLS BACK THE STATEMENT THAT FIRED IT. A
  -- poster tapping "decline" would have got "not authorized to modify this booking"
  -- and the decline would have failed.
  --
  -- It was also pointless: a declined or cancelled booking never reaches a payment
  -- intent, so the pins are inert. Leaving them is strictly better — they record what
  -- the benefit WOULD have been, which is the only evidence of why a use was returned.
  return released + credits;
end;
$$;

revoke execute on function public.release_booking_benefits(uuid, text) from public, anon, authenticated;

-- ── Control ─────────────────────────────────────────────────────────────────
create or replace function public.ctl_credit_stranded_on_dead_booking()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'user_id', b.user_id,
           'amount_cents', b.amount_cents,
           'booking_id', b.applied_booking_id,
           'booking_status', bk.status,
           'applied_at', b.applied_at)
    from public.bonus_ledger b
    join public.bookings bk on bk.id = b.applied_booking_id
   where b.state = 'applied'
     and bk.status in ('declined', 'cancelled')
     and not exists (
       select 1 from public.payments p
        where p.booking_id = bk.id and (p.status = 'captured' or p.captured_at is not null)
     )
$$;

revoke execute on function public.ctl_credit_stranded_on_dead_booking() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('credit_stranded_on_dead_booking',
   'An earned fee credit is still spent against a booking that was declined or cancelled',
   'high', 'money',
   'A fee credit is something the user earned by referring someone who did real work. '
   'If the booking it was applied to died without a capture, no money moved and the '
   'credit must come back. One left in state=applied against a declined or cancelled '
   'booking is value silently taken from a user for work that never happened.',
   'ctl_credit_stranded_on_dead_booking')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
