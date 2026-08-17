-- ─────────────────────────────────────────────────────────────────────────────
-- A poster's one discount is spent by whichever stranger applies first, and no control
-- can see it happen.
--
-- pin_booking_amount runs on booking INSERT — which is when an EARNER APPLIES, not when
-- the poster accepts (20260806320000:152 gates the whole benefit chain on
-- `if tg_op = 'INSERT'`; :200-202 calls consume_poster_discount). So three people apply to
-- one gig, the first application burns the poster's single use, the poster declines that
-- one and hires the third — and the hire they actually made carries no discount, because
-- the grant was already exhausted by someone they never engaged.
--
-- ── WHY THIS IS A CONTROL AND NOT THE FIX ───────────────────────────────────
-- The fix is to consume at ACCEPT. That is not a small change: poster_discount_cents is
-- one of the FOUR immutable values pinned at INSERT, and CLAUDE.md is explicit that
-- capture's idempotency rests on the fee deriving only from values that cannot change.
-- Moving when it is set means quoting at INSERT, consuming at PI creation, and teaching
-- guard_bookings_write to permit exactly one transition of a column whose whole purpose
-- is that it never transitions. That deserves its own design pass against the idempotency
-- proof, not a late addition to an unrelated day's work.
--
-- What can be closed now is that the loss is INVISIBLE. ctl_benefit_never_settled
-- (20260806220000:295) is the control for redemptions that never resolved, and its
-- status filter is `('verified', 'declined', 'cancelled')` — a redemption held by a
-- PENDING booking matches none of them. So the one state where a benefit is held hostage
-- by an application nobody accepted is precisely the state nothing watches.
--
-- expire_stale_pending_bookings(14) eventually cancels the application and releases it,
-- so this self-heals — in fourteen days. A campaign can be over by then, and the poster
-- has already been charged full freight on the hire they did make.
--
-- 48 hours, not 2: unlike the sibling control, a pending booking is a LIVE state a poster
-- is legitimately still thinking about. Two hours would fire on every normal application
-- and be permanent noise, which is the failure this project has now fixed three times.
--
-- Found by the 2026-08-12 payments audit, reproduced against current code 2026-08-14.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_benefit_held_by_pending()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.booking_id::text,
         jsonb_build_object(
           'kind', 'held_by_pending',
           'promotion_id', r.promotion_id,
           'held_for_user', r.user_id,
           'reserved_cents', r.reserved_cents,
           'booking_status', b.status,
           'job_id', b.job_id,
           'age_hours', round(extract(epoch from now() - r.created_at) / 3600.0, 1),
           'note', 'a campaign benefit is consumed and held by an application nobody has '
                   'accepted. Benefits are consumed at booking INSERT — when an earner '
                   'APPLIES — so a poster with one discount use can have it spent by a '
                   'stranger, leaving the hire they actually make at full price. It '
                   'self-heals when expire_stale_pending_bookings(14) cancels the '
                   'application, which can be after the campaign has ended.',
           'remedy', 'Look at the job. If the poster has moved on, decline the stale '
                     'application — release_booking_benefits returns the use and the '
                     'budget. If this is firing often, that is the argument for moving '
                     'consumption to ACCEPT rather than APPLY.'
         )
    from public.promo_redemptions r
    join public.bookings b on b.id = r.booking_id
   where r.released_at is null
     and r.settled_at is null
     -- The gap. ctl_benefit_never_settled filters to verified/declined/cancelled, so a
     -- benefit held by a live application matches nothing it looks at.
     and b.status = 'pending'
     and r.created_at < now() - interval '48 hours'
$$;

revoke execute on function public.ctl_benefit_held_by_pending() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('benefit_held_by_pending',
   'Campaign benefit held by an application nobody accepted',
   'medium', 'money',
   'Benefits are consumed when an earner APPLIES, not when the poster accepts, so a '
   'poster with one discount use can have it spent by a stranger — and the hire they '
   'actually make pays full price. ctl_benefit_never_settled cannot see this: it filters '
   'to verified/declined/cancelled, and this state is pending. Self-heals only when '
   'expire_stale_pending_bookings(14) runs, which can be after the campaign has ended.',
   'ctl_benefit_held_by_pending')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it sees what the sibling control cannot ───────────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; promo uuid; grant_id uuid;
  n_new int; n_old int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.promotions (name, kind, status, fee_bps, budget_cents, max_redemptions)
  values ('held-by-pending probe', 'fee_override', 'active', 0, 100000, 100)
  returning id into promo;

  insert into public.promo_grants (user_id, promotion_id, fee_bps, uses_allowed, uses_consumed)
  values (uid, promo, 0, 1, 1) returning id into grant_id;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'held by pending probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- A LIVE application. This is the state the sibling control cannot express.
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'pending')
  returning id into bid;

  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (grant_id, promo, uid, bid, 0, 500);

  -- Fresh: silent. A poster is legitimately still thinking about it, and firing here
  -- would put a row on the board for every normal application.
  select count(*) into n_new from public.ctl_benefit_held_by_pending() where entity_id = bid::text;
  if n_new <> 0 then
    raise exception 'fired on a fresh application — this would be permanent noise (% rows)', n_new;
  end if;
  raise notice 'a fresh application is silent, so a normal hire never reaches the board';

  -- Aged past the threshold: fires.
  update public.promo_redemptions set created_at = now() - interval '72 hours' where booking_id = bid;
  select count(*) into n_new from public.ctl_benefit_held_by_pending() where entity_id = bid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a 72-hour held benefit reported % rows', n_new;
  end if;

  -- THE DISCRIMINATION: the existing control is blind to exactly this row.
  select count(*) into n_old from public.ctl_benefit_never_settled() where entity_id = bid::text;
  if n_old <> 0 then
    raise exception 'ctl_benefit_never_settled already covered this; the new control is redundant';
  end if;
  raise notice 'discriminates: new control sees it (% row), ctl_benefit_never_settled sees % — that gap is the finding', n_new, n_old;

  -- Released ⇒ resolved. The benefit came back, so there is nothing to act on.
  update public.promo_redemptions set released_at = now() where booking_id = bid;
  select count(*) into n_new from public.ctl_benefit_held_by_pending() where entity_id = bid::text;
  if n_new <> 0 then
    raise exception 'still open after release — this finding could never auto-resolve';
  end if;
  raise notice 'releasing the benefit closes the finding, so it resolves rather than accumulating';

  -- And settled ⇒ resolved too: the booking went through and the campaign paid for it.
  update public.promo_redemptions set released_at = null, settled_at = now() where booking_id = bid;
  select count(*) into n_new from public.ctl_benefit_held_by_pending() where entity_id = bid::text;
  if n_new <> 0 then
    raise exception 'fired on a SETTLED benefit, which is the healthy outcome';
  end if;
  raise notice 'a settled benefit is the healthy outcome and stays off the board';

  if not exists (select 1 from public.controls
                  where key = 'benefit_held_by_pending' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'held-by-pending probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
