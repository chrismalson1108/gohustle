-- ─────────────────────────────────────────────────────────────────────────────
-- ctl_bonus_vesting_stalled reports a bonus DELIBERATELY held by an open dispute as
-- "the sweep is not running or is erroring".
--
-- vest_bonuses() has two reasons to leave a bonus `pending` past its vests_at, and they
-- want opposite responses from a human:
--
--   1. The sweep did not run, or errored. Nobody is holding the row; the person who
--      earned a referral reward is silently not getting it. Remedy: fix the sweep.
--   2. The source gig is under an open dispute. The final vest_bonuses
--      (20260814150000:98-105) ends its vesting UPDATE with
--          and not exists (select 1 from public.disputes d
--                           where d.booking_id = b.source_booking_id
--                             and coalesce(d.status, 'open') in ('open','investigating'))
--      — a deliberate hold, matching the design note at 20260806080000:121-124 that a
--      disputed referral is not, in the end, a successful one. Remedy: resolve the
--      dispute. Nothing about the sweep is wrong.
--
-- The control (20260806080000:303-318) knew only about the first. Its predicate was
-- `state = 'pending' and vests_at < now() - interval '2 days'` with no reference to
-- disputes, its detail carried no dispute fields, and its registry `why` asserted cause
-- (1) for every row: "A bonus sitting pending well past vests_at means the sweep is not
-- running or is erroring." So a dispute-held bonus opened a medium/money finding with a
-- WRONG DIAGNOSIS. The operator checks pg_cron and controls.last_run_at, finds a healthy
-- sweep, closes the finding, and it re-opens on the next sweep — for as long as the
-- dispute stands.
--
-- The realistic timeline: stripe-capture-payment files a `disputes` row on a partial
-- capture at verification, and accrue_referral_bonus mints the bonus at that same
-- verification with vests_at = now() + 7 days. So the dispute opens on day 0, this
-- control files on day 9, and ctl_dispute_open_beyond_sla — the control that can actually
-- name the cause — does not fire until day 14. Roughly five days of a finding pointing
-- the operator at the one thing that is working.
--
-- ── WHY THE ROW STAYS ON THE BOARD ──────────────────────────────────────────
-- The obvious fix is to exclude dispute-held bonuses and let the dispute control own
-- them. That trades a wrong diagnosis for silence, and silence is worse here: the bonus
-- is real money owed to a real person, the dispute control fires five days later and
-- says nothing about the bonus, and if the dispute is later resolved-but-the-sweep-is-
-- broken there is no longer any row watching the bonus at all. The defect was the
-- DIAGNOSIS, not the finding. So the control keeps firing and now says which of the two
-- causes it is, names the dispute, and gives the matching remedy.
--
-- ── ONE ROW PER BONUS ───────────────────────────────────────────────────────
-- The dispute is attached through a `left join lateral … limit 1`, not a plain join: a
-- booking with two open disputes would otherwise return the same bonus id twice, and
-- run_control's ON CONFLICT upsert aborts the whole control with SQLSTATE 21000 when one
-- entity appears twice (20260906045000). run_control now de-duplicates, but a control
-- that fans out still merges two findings into one — see __tests__/controlEntityUniqueness.
--
-- Found by the controls-registry audit (controls-registry#8), reproduced against current
-- code 2026-09-06.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_bonus_vesting_stalled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           -- The field that stops the operator being sent to a healthy pg_cron job.
           'cause', case when d.id is null then 'sweep_not_vesting' else 'held_by_dispute' end,
           'user_id', b.user_id, 'amount_cents', b.amount_cents,
           'vests_at', b.vests_at, 'state', b.state,
           'days_overdue', round(extract(epoch from now() - b.vests_at) / 86400)::int,
           'source_booking_id', b.source_booking_id,
           'dispute_id', d.id,
           'dispute_status', d.status,
           'dispute_opened_at', d.created_at,
           'dispute_age_days', case when d.id is null then null
                                    else round(extract(epoch from now() - d.created_at) / 86400)::int
                               end,
           'remedy', case when d.id is null then
               'Nothing is holding this row. vest_bonuses() should have flipped it on the '
               'last sweep, so the sweep is not running or is erroring — check '
               'controls.last_run_at, controls.last_error and the pg_cron entry. Someone '
               'who earned a referral reward is silently not getting it.'
             else
               'Working as designed, and waiting on a HUMAN. vest_bonuses() refuses to pay '
               'a referral whose source gig is under an open dispute, so the sweep is fine '
               'and checking it is wasted time. Resolve the named dispute in /disputes: the '
               'next sweep vests the bonus, or voids it if the booking was reversed. '
               'ctl_dispute_open_beyond_sla will not raise the same dispute until day 14.'
             end)
    from public.bonus_ledger b
    -- LATERAL … LIMIT 1, so a booking carrying two open disputes cannot return this
    -- bonus twice. Oldest first: that is the one the SLA control will name.
    left join lateral (
      select dd.id, dd.status, dd.created_at
        from public.disputes dd
       where dd.booking_id = b.source_booking_id
         and coalesce(dd.status, 'open') in ('open', 'investigating')
       order by dd.created_at asc
       limit 1
    ) d on true
   where b.state = 'pending'
     and b.vests_at < now() - interval '2 days'
$$;

revoke execute on function public.ctl_bonus_vesting_stalled() from public, anon, authenticated;

-- The registry text is what the operator reads on /controls, so it has to carry the same
-- distinction the detail now does. Re-inserted rather than updated so the row exists even
-- on a database built from a truncated history.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('bonus_vesting_stalled',
   'Referral bonus past its vesting date and still pending',
   'medium', 'money',
   'vest_bonuses() flips pending -> payable once the refund window closes, '
   'UNLESS the source gig is under an open dispute — a hold it applies on '
   'purpose (20260814150000:98-105), because a disputed referral is not, in the '
   'end, a successful one. So a row here has exactly two causes and detail.cause '
   'names which. cause=sweep_not_vesting: nothing is holding it, the sweep is not '
   'running or is erroring, and someone who earned a referral reward is silently '
   'not getting it. cause=held_by_dispute: the hold is correct and the remedy is '
   'to resolve the dispute named in detail.dispute_id — the sweep is healthy and '
   'checking it is wasted time. This why used to assert the first cause for BOTH, '
   'so a dispute-held bonus sent the operator to a working pg_cron job and the '
   'finding re-opened every sweep until the dispute closed on its own, up to five '
   'days before ctl_dispute_open_beyond_sla named the real cause.',
   'ctl_bonus_vesting_stalled')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove the control now tells the operator the truth ──────────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; did uuid; lid uuid;
  d jsonb; n int; k int; src text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- The hold this control has to know about is a clause in vest_bonuses. Read it off the
  -- live function rather than trusting this file's account of it: if the hold were ever
  -- removed, the whole 'held_by_dispute' cause would be a fiction.
  src := pg_get_functiondef('public.vest_bonuses()'::regprocedure);
  if src !~ 'public\.disputes' or src !~ 'investigating' then
    raise exception 'vest_bonuses no longer holds on open disputes — the cause this control '
                    'reports would be invented';
  end if;
  raise notice 'vest_bonuses still holds a pending bonus behind an open dispute, so the new cause is real';

  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'bonus vesting diagnosis probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'completed')
  returning id into bid;

  -- A referral bonus that reached its vesting date three days ago and is still pending.
  insert into public.bonus_ledger
    (user_id, reason, amount_cents, delivery, state, source_booking_id, source_user_id, vests_at)
  values (uid, 'referral-probe', 500, 'credit', 'pending', bid, uid, now() - interval '3 days')
  returning id into lid;

  -- ── Arm 1: nothing holding it. The original cause, and it must still report. ──
  select count(*) into n from public.ctl_bonus_vesting_stalled() where entity_id = lid::text;
  if n <> 1 then
    raise exception 'FIX FAILED: an unheld pending bonus 3 days past vests_at reported % rows', n;
  end if;
  select detail into d from public.ctl_bonus_vesting_stalled() where entity_id = lid::text;
  if d->>'cause' <> 'sweep_not_vesting' then
    raise exception 'unheld bonus reported cause=%, expected sweep_not_vesting', d->>'cause';
  end if;
  if d->>'dispute_id' is not null then
    raise exception 'named a dispute where there is none';
  end if;
  raise notice 'an unheld overdue bonus still fires, and now says the sweep is the thing to check';

  -- ── Arm 2: the same row, held by an open dispute. ────────────────────────────
  insert into public.disputes (booking_id, raised_by, reason, pct_paid, status, created_at)
  values (bid, uid, 'probe', 50, 'open', now() - interval '10 days')
  returning id into did;

  select count(*) into n from public.ctl_bonus_vesting_stalled() where entity_id = lid::text;
  if n <> 1 then
    raise exception 'a dispute-held bonus returned % rows — one bonus must be exactly one finding', n;
  end if;
  select detail into d from public.ctl_bonus_vesting_stalled() where entity_id = lid::text;

  -- THE DISCRIMINATION. The old body had no `cause` and no dispute fields at all, so it
  -- could only ever be read through a registry `why` that said the sweep was broken.
  if d->>'cause' <> 'held_by_dispute' then
    raise exception 'FIX ABSENT: a dispute-held bonus still reports cause=% — this is the '
                    'row the operator takes to a healthy pg_cron job', coalesce(d->>'cause', '(no cause field)');
  end if;
  if d->>'dispute_id' <> did::text then
    raise exception 'the finding does not name the dispute holding it (dispute_id=%)', d->>'dispute_id';
  end if;
  if (d->>'dispute_age_days')::int < 9 then
    raise exception 'dispute_age_days=% does not reflect the 10-day-old dispute', d->>'dispute_age_days';
  end if;
  if d->>'remedy' !~ 'Resolve the named dispute' then
    raise exception 'the remedy still points at the sweep rather than the dispute';
  end if;
  raise notice 'discriminates: the dispute-held row names the dispute, its age, and "resolve the dispute" as the remedy';

  -- And the hold it reports is the real one — this is vest_bonuses''s own vesting
  -- statement, scoped to the staged row so nothing else in the ledger is touched.
  update public.bonus_ledger b set state = 'payable'
   where b.id = lid and b.state = 'pending' and b.vests_at <= now()
     and not exists (
       select 1 from public.disputes dd where dd.booking_id = b.source_booking_id
         and coalesce(dd.status, 'open') in ('open', 'investigating'));
  get diagnostics k = row_count;
  if k <> 0 then
    raise exception 'the dispute did not hold the bonus, so held_by_dispute would be a wrong cause too';
  end if;
  raise notice 'the bonus genuinely cannot vest while the dispute stands, so the reported cause is the real one';

  -- ── Arm 3: resolve the dispute. The hold lifts, the cause flips back. ────────
  update public.disputes set status = 'resolved', resolved_at = now() where id = did;
  select detail into d from public.ctl_bonus_vesting_stalled() where entity_id = lid::text;
  if d->>'cause' <> 'sweep_not_vesting' then
    raise exception 'a resolved dispute still reads as held_by_dispute';
  end if;
  update public.bonus_ledger b set state = 'payable'
   where b.id = lid and b.state = 'pending' and b.vests_at <= now()
     and not exists (
       select 1 from public.disputes dd where dd.booking_id = b.source_booking_id
         and coalesce(dd.status, 'open') in ('open', 'investigating'));
  get diagnostics k = row_count;
  if k <> 1 then
    raise exception 'the bonus could not vest even with the dispute resolved';
  end if;
  raise notice 'resolving the dispute lifts the hold and the cause returns to sweep_not_vesting';

  -- ── And a vested bonus leaves the board, so findings resolve rather than pile up. ──
  select count(*) into n from public.ctl_bonus_vesting_stalled() where entity_id = lid::text;
  if n <> 0 then
    raise exception 'a payable bonus is still reported — this finding could never auto-resolve';
  end if;
  raise notice 'once vested the finding auto-resolves';

  if not exists (select 1 from public.controls
                  where key = 'bonus_vesting_stalled' and enabled and not external
                    and why like '%held_by_dispute%') then
    raise exception 'the registry why still describes only the broken-sweep cause';
  end if;
  raise notice 'the registry why names both causes, so the board reads the same as the detail';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'bonus vesting diagnosis probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
