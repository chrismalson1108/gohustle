-- ─────────────────────────────────────────────────────────────────────────────
-- A CRITICAL control that fires on the intended outcome of a decline.
--
-- ctl_discount_without_grant exists to catch real money-off-the-charge that no campaign
-- paid for. Its predicate is
--
--     coalesce(b.poster_discount_cents, 0) > 0
--     and not exists (redemption r join promotions p
--                     where r.booking_id = b.id
--                       and r.released_at is null          -- ← this
--                       and p.kind = 'poster_discount')
--
-- and `released_at is null` is exactly what a decline sets. 20260806260000 stamps
-- released_at on the redemption when a booking dies, and it DELIBERATELY leaves
-- bookings.poster_discount_cents in place — its own comment explains why at length:
-- clearing it re-entered guard_bookings_write from an AFTER trigger and rolled back the
-- decline itself.
--
-- So every declined or cancelled booking that ever carried a poster discount becomes a
-- permanent CRITICAL finding describing a state the system deliberately produces. It
-- cannot auto-resolve, because the control keeps returning it. A board carrying permanent
-- criticals that everyone knows to ignore is worse than one short a check — it trains
-- people to scroll past the row that is real.
--
-- Found by the 2026-08-12 payments audit, reproduced against current code 2026-08-14.
--
-- TWO CHANGES, both narrowing toward the bug it was written for:
--  1. Drop `released_at is null` from the NOT EXISTS. A RELEASED redemption is still
--     evidence that a campaign granted the discount — which is the whole question. The
--     bug shape is "no poster_discount redemption EVER existed for this booking".
--  2. Exclude dead bookings. Nothing is owed on a declined or cancelled one; the pinned
--     column is a historical record of what was quoted, not a live charge.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_discount_without_grant()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'poster_discount_cents', b.poster_discount_cents,
           'booking_status', b.status,
           -- No released_at filter here either: showing which campaign it came from is
           -- more useful than showing nothing because the redemption has been released.
           'redemption_kind', (
             select p.kind from public.promo_redemptions r
              join public.promotions p on p.id = r.promotion_id
             where r.booking_id = b.id limit 1),
           'note', 'a poster discount was applied with no poster_discount redemption '
                   'behind it — money off the charge that no campaign paid for')
    from public.bookings b
   where coalesce(b.poster_discount_cents, 0) > 0
     -- A decline RELEASES the redemption and deliberately leaves poster_discount_cents
     -- alone (20260806260000). Nothing is owed on a dead booking, so it is not a finding.
     and b.status not in ('declined', 'cancelled')
     and not exists (
       select 1 from public.promo_redemptions r
        join public.promotions p on p.id = r.promotion_id
       where r.booking_id = b.id
         and p.kind = 'poster_discount'
     )
$$;

revoke execute on function public.ctl_discount_without_grant() from public, anon, authenticated;

-- ── Prove it discriminates on both sides ────────────────────────────────────
do $$
declare
  uid uuid; jid uuid; jid2 uuid; bid_dead uuid; bid_real uuid; promo uuid; grant_id uuid;
  n_dead int; n_real int; n_old_dead int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'discount ctl probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;

  insert into public.promotions (name, kind, status, poster_discount_cents, budget_cents, max_redemptions)
  values ('probe discount', 'poster_discount', 'active', 355, 100000, 100)
  returning id into promo;

  -- (A) A DECLINED booking whose redemption was released — the intended outcome.
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'declined')
  returning id into bid_dead;
  update public.bookings set poster_discount_cents = 355 where id = bid_dead;
  -- promo_redemptions.grant_id is NOT NULL — a redemption is always a claim against a
  -- specific grant, which is what makes stacking die at the unique indexes.
  insert into public.promo_grants (user_id, promotion_id, uses_allowed)
  values (uid, promo, 1) returning id into grant_id;
  insert into public.promo_redemptions
    (grant_id, promotion_id, booking_id, user_id, fee_bps, benefit_cents, released_at)
  values (grant_id, promo, bid_dead, uid, 0, 355, now());

  -- (B) A LIVE booking with a discount and NO redemption at all — the real bug.
  -- A SECOND job: bookings is unique on (job_id, earner_id), so the same earner cannot
  -- hold two bookings on one listing.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'discount ctl probe 2', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, uid, 'confirmed')
  returning id into bid_real;
  update public.bookings set poster_discount_cents = 355 where id = bid_real;
  -- Inserting a booking runs pin_booking_amount, which CONSUMES the live grant staged
  -- above and writes a legitimate redemption. Remove it: the shape under test is a
  -- discount with no campaign behind it at all, which is the actual bug this control is
  -- for. Without this the probe stages a correct booking and proves nothing.
  delete from public.promo_redemptions where booking_id = bid_real;

  -- What the OLD predicate did to (A): released_at is null excluded the released
  -- redemption, so the NOT EXISTS was satisfied and it fired.
  select count(*) into n_old_dead
    from public.bookings b
   where b.id = bid_dead
     and coalesce(b.poster_discount_cents, 0) > 0
     and not exists (
       select 1 from public.promo_redemptions r
        join public.promotions p on p.id = r.promotion_id
       where r.booking_id = b.id and r.released_at is null and p.kind = 'poster_discount');
  if n_old_dead <> 1 then
    raise exception 'probe is not discriminating: the old predicate did not fire on the declined booking';
  end if;

  select count(*) into n_dead from public.ctl_discount_without_grant() where entity_id = bid_dead::text;
  select count(*) into n_real from public.ctl_discount_without_grant() where entity_id = bid_real::text;

  if n_dead <> 0 then
    raise exception 'STILL FIRES on a declined booking (% rows) — the permanent critical is not fixed', n_dead;
  end if;
  raise notice 'discriminates: old predicate fired on the declined booking, new one does not';

  if n_real <> 1 then
    raise exception 'OVER-CORRECTED: a live discount with no campaign behind it is now invisible (% rows)', n_real;
  end if;
  raise notice 'the real shape — money off a live charge no campaign paid for — still fires';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'discount-control probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
