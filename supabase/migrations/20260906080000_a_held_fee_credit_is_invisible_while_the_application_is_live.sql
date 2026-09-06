-- ─────────────────────────────────────────────────────────────────────────────
-- An earner's referral credit, spent by an application nobody answered, is watched by
-- nothing at all.
--
-- 20260817030000 closed the detection half of consume-at-APPLY for ONE of the three
-- benefits. Its control reads public.promo_redemptions and only that table. But
-- pin_booking_amount (20260806320000:152,189) spends all three on the same INSERT, and
-- consume_fee_credit (final definition 20260814150000:112-171) flips the earner's own
-- bonus_ledger rows to state='applied' with applied_booking_id = the new booking. So the
-- benefit the user EARNED — by referring a real person who did real work and paid a real
-- fee — is consumed by an application, and the control written for exactly this shape
-- cannot see it.
--
-- The sibling credit control does not cover it either. ctl_credit_stranded_on_dead_booking
-- (20260806260000:105-127) requires `bk.status in ('declined','cancelled')` at :122, and
-- that is precisely the moment trg_zz_release_benefits gives the credit back. It is the
-- net for a release that FAILED. Nothing looks at the window before the release is due.
--
--   Earner holds a 1000c credit. Monday they apply to gig A; the INSERT takes the whole
--   credit. Tuesday they apply to gig B; consume_fee_credit finds no payable rows and
--   pins fee_credit_cents = 0. B's poster hires them and B captures at the full fee.
--   A's poster never answers. Fourteen days later expire_stale_pending_bookings(14)
--   cancels A and the credit comes back — to be spent on some future gig, having done
--   nothing for the one they actually worked. No control fired for a fortnight.
--
-- The console does render bonus_ledger state and its applied booking, so an operator who
-- goes looking can see this. What was missing is anything that makes someone look.
--
-- ── WHY THIS IS STILL A CONTROL AND NOT THE FIX ─────────────────────────────
-- Unchanged from 20260817030000: the fix is to consume at ACCEPT, and fee_credit_cents is
-- one of the FOUR immutable values pinned at INSERT that capture's idempotency rests on.
-- That is a design pass against the idempotency proof, not a line here.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────────
-- A second arm on the SAME control, because it is the same finding about the same
-- booking, and an operator triaging "a benefit is held by an application nobody
-- accepted" wants both in one queue.
--
--   · 48 hours, matching the promo arm and for the same reason: a pending booking is a
--     live state a poster is legitimately still thinking about, and a shorter threshold
--     would fire on every normal application and become permanent noise.
--   · The credit arm is namespaced 'credit:<booking>'. One INSERT can spend a promo
--     grant AND a credit, so an un-namespaced second arm would return the same
--     entity_id twice. run_control now merges rather than aborting (20260906045000), but
--     that migration is explicit that a merged finding is a fallback and not the target
--     state. The promo arm keeps its bare booking id so findings open under it today
--     keep their identity and their age instead of resolving and reopening.
--   · The credit arm is GROUPED per booking: consume_fee_credit splits a partially-usable
--     credit into two rows, and two ledger rows on one application is one thing to act on,
--     not two.
--   · detail carries `later_applications_without_credit` — the count of that earner's
--     later live bookings pinned at fee_credit_cents = 0. That number is the actual harm:
--     it is how many gigs they took while their credit sat on this one.
--
-- Found by the 2026-09-05 audit as money-db-incentives#10, verified against the final
-- definitions of consume_fee_credit, pin_booking_amount and both existing controls.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_benefit_held_by_pending()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  -- ── Arm 1: a campaign benefit. Unchanged from 20260817030000, including the bare
  --    booking id, so open findings keep their identity. ──────────────────────
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

  union all

  -- ── Arm 2: the earner's OWN fee credit. Same root cause, different ledger, and
  --    neither existing control reads this table in this state. ───────────────
  select 'credit:' || bk.id::text,
         jsonb_build_object(
           'kind', 'credit_held_by_pending',
           'booking_id', bk.id,
           'held_for_user', bl.user_id,
           'held_cents', sum(bl.amount_cents),
           'credit_rows', count(*),
           'booking_status', bk.status,
           'job_id', bk.job_id,
           'age_hours', round(
             extract(epoch from now() - min(coalesce(bl.applied_at, bl.created_at))) / 3600.0, 1),
           -- The harm, counted: live bookings this earner made AFTER this one that were
           -- pinned at zero credit. Every one of those is a gig they worked while the
           -- credit they earned sat on an application nobody answered.
           'later_applications_without_credit', (
             select count(*) from public.bookings b2
              where b2.earner_id = bk.earner_id
                and b2.id <> bk.id
                and b2.created_at > bk.created_at
                and coalesce(b2.fee_credit_cents, 0) = 0
                and b2.status in ('pending', 'confirmed', 'completed', 'verified')
           ),
           'note', 'a referral fee credit is consumed and held by an application nobody '
                   'has accepted. consume_fee_credit runs at booking INSERT — when an '
                   'earner APPLIES — so the first gig they apply to takes the whole '
                   'credit, and the gig they are actually hired for is pinned at zero. '
                   'ctl_credit_stranded_on_dead_booking cannot see this: it requires the '
                   'booking to be declined or cancelled, which is the moment the credit '
                   'is released anyway. This self-heals only when '
                   'expire_stale_pending_bookings(14) cancels the application.',
           'remedy', 'Look at the job. If the poster has moved on, decline the stale '
                     'application — release_booking_benefits returns the credit to '
                     'payable. If later_applications_without_credit is above zero the '
                     'earner has already been charged full freight on work they did, and '
                     'that is a make-good, not just a cleanup. Frequent firings are the '
                     'argument for moving consumption to ACCEPT rather than APPLY.'
         )
    from public.bonus_ledger bl
    join public.bookings bk on bk.id = bl.applied_booking_id
   where bl.state = 'applied'
     and bl.delivery = 'credit'
     and bk.status = 'pending'
     and coalesce(bl.applied_at, bl.created_at) < now() - interval '48 hours'
   group by bk.id, bl.user_id, bk.status, bk.job_id, bk.earner_id, bk.created_at
$$;

revoke execute on function public.ctl_benefit_held_by_pending() from public, anon, authenticated;

-- Same key, so no new registry row and no change to the registered count. The wording is
-- updated because the control now watches two ledgers and the old text named only one.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('benefit_held_by_pending',
   'A campaign benefit or a fee credit is held by an application nobody accepted',
   'medium', 'money',
   'Benefits are consumed when an earner APPLIES, not when the poster accepts. A poster '
   'with one discount use can have it spent by a stranger, and an earner''s referral fee '
   'credit is taken by the first gig they apply to rather than the one they are hired '
   'for. Neither sibling control can see it: ctl_benefit_never_settled filters to '
   'verified/declined/cancelled, and ctl_credit_stranded_on_dead_booking requires the '
   'booking to be dead — which is the moment the benefit is released anyway. This state '
   'is pending, and it self-heals only when expire_stale_pending_bookings(14) runs, which '
   'can be after the campaign has ended and after the earner has worked gigs at full fee.',
   'ctl_benefit_held_by_pending')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove the new arm sees what nothing else could ──────────────────────────
do $$
declare
  uid uuid; other uuid;
  jid uuid; bid uuid; jid2 uuid; bid2 uuid;
  promo uuid; gid uuid; pbid uuid; pjid uuid;
  n_new int; n_old int; n_promo int; n_stranded int; held bigint; later_zero int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;
  select id into other from public.profiles where deleted_at is null and id <> uid limit 1;
  if other is null then other := uid; end if;

  -- Gig A: the application that takes the credit and is never answered.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (other, 'credit held by pending probe A', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'pending')
  returning id into bid;

  -- Gig B: the gig they were actually hired for, pinned at zero credit because A took it.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (other, 'credit held by pending probe B', 'Odd Jobs', 300, 'flat', 'Probe', 'probe', 'open')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, uid, 'pending')
  returning id into bid2;

  -- A applies BEFORE B. created_at defaults to now(), which inside one transaction is the
  -- same instant for both rows, so without this the "later application" arm compares equal
  -- timestamps and the assertion below would pass or fail for the wrong reason.
  update public.bookings set created_at = now() - interval '5 days' where id = bid;
  update public.bookings set fee_credit_cents = 0 where id = bid2;

  -- pin_booking_amount just ran on both inserts under a REAL profile, so it may have
  -- consumed that person's live credit onto a probe booking. Detach anything it took —
  -- exactly what release_booking_benefits does — or the sums below measure live data
  -- instead of the staged row. (Everything here rolls back regardless.)
  update public.bonus_ledger
     set state = 'payable', applied_at = null, applied_booking_id = null
   where applied_booking_id in (bid, bid2);

  -- The state consume_fee_credit leaves behind. Two rows, because it SPLITS a
  -- partially-usable credit — the control must report one finding, not two.
  insert into public.bonus_ledger (user_id, reason, amount_cents, delivery, state,
                                   applied_at, applied_booking_id)
  values (uid, 'held-by-pending probe part 1', 600, 'credit', 'applied', now(), bid),
         (uid, 'held-by-pending probe part 2', 400, 'credit', 'applied', now(), bid);

  -- 1. Fresh: silent. A poster is legitimately still deciding, and firing here would put
  --    a row on the board for every normal application.
  select count(*) into n_new
    from public.ctl_benefit_held_by_pending() where entity_id = 'credit:' || bid::text;
  if n_new <> 0 then
    raise exception 'fired on a fresh application — this would be permanent noise (% rows)', n_new;
  end if;
  raise notice 'a fresh application is silent, so a normal hire never reaches the board';

  -- 2. Aged past the threshold: ONE row, both ledger rows summed into it.
  update public.bonus_ledger set applied_at = now() - interval '72 hours'
   where applied_booking_id = bid;
  select count(*) into n_new
    from public.ctl_benefit_held_by_pending() where entity_id = 'credit:' || bid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a 72-hour held credit reported % rows (want exactly 1)', n_new;
  end if;

  select (detail->>'held_cents')::bigint,
         (detail->>'later_applications_without_credit')::int
    into held, later_zero
    from public.ctl_benefit_held_by_pending() where entity_id = 'credit:' || bid::text;
  if held <> 1000 then
    raise exception 'split credit rows were not summed: held_cents = % (want 1000)', held;
  end if;
  if later_zero < 1 then
    raise exception 'the later zero-credit application was not counted: % (want >= 1)', later_zero;
  end if;
  raise notice 'one finding naming the whole 1000c and the % later gig(s) pinned at zero credit', later_zero;

  -- 3. THE DISCRIMINATION, part one: the control body this replaces read
  --    promo_redemptions and nothing else. Evaluated here on the very same booking.
  select count(*) into n_old
    from public.promo_redemptions r
    join public.bookings b on b.id = r.booking_id
   where r.released_at is null and r.settled_at is null
     and b.status = 'pending'
     and r.created_at < now() - interval '48 hours'
     and r.booking_id = bid;
  if n_old <> 0 then
    raise exception 'staging wrong: the probe booking holds a promo redemption too';
  end if;
  raise notice 'discriminates: the pre-fix promo-only body returns % rows for this booking', n_old;

  -- 4. THE DISCRIMINATION, part two: the sibling credit control is blind to it, because
  --    it requires a dead booking — the state in which the credit is released anyway.
  select count(*) into n_stranded
    from public.ctl_credit_stranded_on_dead_booking() where entity_id in (
      select id::text from public.bonus_ledger where applied_booking_id = bid);
  if n_stranded <> 0 then
    raise exception 'ctl_credit_stranded_on_dead_booking already covered this; the arm is redundant';
  end if;
  raise notice 'ctl_credit_stranded_on_dead_booking sees % — that gap is the finding', n_stranded;

  -- 5. Releasing the credit closes the finding, so it resolves rather than accumulating.
  --    This is exactly what release_booking_benefits does on decline.
  update public.bonus_ledger
     set state = 'payable', applied_at = null, applied_booking_id = null
   where applied_booking_id = bid;
  select count(*) into n_new
    from public.ctl_benefit_held_by_pending() where entity_id = 'credit:' || bid::text;
  if n_new <> 0 then
    raise exception 'still open after the credit was returned — this could never auto-resolve';
  end if;
  raise notice 'returning the credit to payable closes the finding';

  -- 6. REGRESSION: arm 1 still fires, still under the bare booking id.
  insert into public.promotions (name, kind, status, fee_bps, budget_cents, max_redemptions)
  values ('held-by-pending arm-1 regression probe', 'fee_override', 'active', 0, 100000, 100)
  returning id into promo;
  insert into public.promo_grants (user_id, promotion_id, fee_bps, uses_allowed, uses_consumed)
  values (uid, promo, 0, 1, 1) returning id into gid;
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (other, 'held by pending arm-1 probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into pjid;
  insert into public.bookings (job_id, earner_id, status) values (pjid, uid, 'pending')
  returning id into pbid;
  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (gid, promo, uid, pbid, 0, 500);
  -- Scoped to the probe's own grant: pin_booking_amount may have consumed a real active
  -- grant onto this booking too, and ageing that one would make the count below measure
  -- live campaign data rather than the staged row.
  update public.promo_redemptions set created_at = now() - interval '72 hours'
   where booking_id = pbid and grant_id = gid;

  select count(*) into n_promo
    from public.ctl_benefit_held_by_pending() where entity_id = pbid::text;
  if n_promo <> 1 then
    raise exception 'REGRESSION: the campaign-benefit arm reported % rows (want 1)', n_promo;
  end if;
  raise notice 'the campaign arm still fires under its original bare booking id';

  -- 7. And the two arms cannot collide: even when ONE application holds both, each is
  --    its own entity, so run_control files two actionable rows instead of merging.
  insert into public.bonus_ledger (user_id, reason, amount_cents, delivery, state,
                                   applied_at, applied_booking_id)
  values (uid, 'both-benefits probe', 250, 'credit', 'applied',
          now() - interval '72 hours', pbid);
  select count(*) into n_new
    from public.ctl_benefit_held_by_pending()
   where entity_id in (pbid::text, 'credit:' || pbid::text);
  if n_new <> 2 then
    raise exception 'one booking holding both benefits produced % rows (want 2, distinct ids)', n_new;
  end if;
  if (select count(distinct entity_id) from public.ctl_benefit_held_by_pending()
       where entity_id in (pbid::text, 'credit:' || pbid::text)) <> 2 then
    raise exception 'the two arms share an entity_id — run_control would merge them';
  end if;
  raise notice 'both benefits on one application are two distinct findings, not a merged row';

  if not exists (select 1 from public.controls
                  where key = 'benefit_held_by_pending' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'credit-held-by-pending probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
