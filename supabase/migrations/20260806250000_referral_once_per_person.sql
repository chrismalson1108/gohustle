-- ─────────────────────────────────────────────────────────────────────────────
-- A referral bonus paid out once per COMPLETED GIG, not once per person referred.
--
-- accrue_referral_bonus fires whenever a booking becomes 'verified', looks up who
-- referred the earner, and mints a bonus. The only dedupe is bonus_ledger_dedupe, on
-- (user_id, reason, source_booking_id) — which is per BOOKING. So a different booking
-- by the same referred earner mints another bonus, and another, indefinitely.
--
-- Refer one person, and every gig they ever complete pays you again. That is a revenue
-- share, not a referral bonus, and it is precisely the farming vector this system was
-- built to prevent: the campaign's budget still bounds total exposure, but a SINGLE
-- pair can drain the entire campaign by doing ordinary work.
--
-- The vest-on-outcome design is what makes farming unprofitable — a fake referral has
-- to do real work and pay real fees to vest. That reasoning holds for ONE bonus. It
-- does not hold when the same pair can collect repeatedly, because the cost of the
-- first gig is amortised over an unbounded number of payouts.
--
-- ── AND THE BUDGET LEAKED ON EVERY DEDUPED INSERT ───────────────────────────
--
-- The ceiling increment ran BEFORE the insert:
--
--   update promotions set redemptions_used = +1, spent_cents = +bonus_cents ...
--   insert into bonus_ledger ... on conflict do nothing;
--
-- so any re-fire on a booking that already had a bonus — a replayed webhook, a
-- re-verification — charged the campaign again while `on conflict do nothing` silently
-- discarded the row. Same defect as consume_poster_discount (20260806240000): the
-- accounting is not covered by the thing that deduplicates the record.
--
-- Fixed the same way: INSERT FIRST, let the unique indexes arbitrate, and charge the
-- campaign only if a row was actually created.
-- ─────────────────────────────────────────────────────────────────────────────

-- One referral bonus per (referrer, referred person). The per-booking index stays —
-- it still makes a replayed trigger on one booking a no-op.
create unique index if not exists bonus_ledger_one_per_referral
  on public.bonus_ledger (user_id, source_user_id)
  where reason = 'referral' and source_user_id is not null and state <> 'void';

create or replace function public.accrue_referral_bonus()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  referrer uuid;
  promo    public.promotions%rowtype;
  made     integer := 0;
begin
  if new.status <> 'verified' or coalesce(old.status, '') = 'verified' then
    return new;
  end if;

  select r.referrer_id into referrer
    from public.referrals r where r.referred_id = new.earner_id;
  if referrer is null or referrer = new.earner_id then
    return new;
  end if;

  select * into promo from public.promotions
   where kind = 'bonus' and status = 'active'
     and starts_at <= now() and (ends_at is null or ends_at > now())
   order by created_at desc limit 1;
  if not found then return new; end if;

  -- INSERT FIRST. bonus_ledger_one_per_referral rejects a second bonus for this pair
  -- and bonus_ledger_dedupe rejects a replay on this booking; either way we learn it
  -- here, BEFORE any money is committed against the campaign.
  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state,
     source_booking_id, source_user_id, vests_at)
  values (referrer, promo.id, 'referral', promo.bonus_cents, promo.bonus_delivery,
          'pending', new.id, new.earner_id, now() + interval '7 days')
  on conflict do nothing;

  get diagnostics made = row_count;
  if made = 0 then
    -- Already bonused for this pair (or this booking). Nothing minted, so nothing is
    -- charged. This is the leak that used to happen here.
    return new;
  end if;

  -- Ceiling check as an increment, same discipline as fee promotions.
  update public.promotions
     set redemptions_used = redemptions_used + 1,
         spent_cents = spent_cents + promo.bonus_cents
   where id = promo.id
     and redemptions_used < max_redemptions
     and spent_cents + promo.bonus_cents <= budget_cents;

  if not found then
    -- Campaign is exhausted. Withdraw the bonus we just minted rather than paying one
    -- the budget never funded.
    delete from public.bonus_ledger
     where source_booking_id = new.id and user_id = referrer and reason = 'referral';
  end if;

  return new;
exception when others then
  -- A bonus bug must never block a verification, which is what releases the
  -- earner's money.
  raise warning 'referral bonus accrual failed for booking %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke execute on function public.accrue_referral_bonus() from public, anon, authenticated;

-- ── Watch for the pattern, not just this bug ────────────────────────────────
create or replace function public.ctl_referral_bonus_repeat()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.user_id::text,
         jsonb_build_object(
           'referred_user', b.source_user_id,
           'bonus_count', count(*),
           'total_cents', sum(b.amount_cents),
           'states', array_agg(distinct b.state))
    from public.bonus_ledger b
   where b.reason = 'referral'
     and b.state <> 'void'
     and b.source_user_id is not null
   group by b.user_id, b.source_user_id
  having count(*) > 1
$$;

revoke execute on function public.ctl_referral_bonus_repeat() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('referral_bonus_repeat',
   'One referrer collected more than one bonus for the same referred person',
   'critical', 'money',
   'A referral bonus is per person referred. More than one live bonus for the same '
   '(referrer, referred) pair means the per-pair guard is not holding — which lets a '
   'single pair drain a campaign by doing ordinary work, the exact farming vector the '
   'vest-on-outcome design exists to prevent.',
   'ctl_referral_bonus_repeat')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
