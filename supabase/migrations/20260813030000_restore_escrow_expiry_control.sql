-- ─────────────────────────────────────────────────────────────────────────────
-- CRITICAL, LIVE: the escrow-expiry control has been blind since 2026-08-06.
--
-- `ctl_escrow_hold_expiring_work_done` exists to catch ONE population: an earner who
-- did the work and marked it done, whose poster has gone quiet, whose Stripe
-- authorization is 24–48 hours from expiring. When that hold voids there is nothing
-- left to capture and the earner is simply not paid — the full gig value, up to the
-- $10,000 cap, per event.
--
-- 20260806150000_authorized_at.sql meant only to re-anchor the clock onto
-- `payments.authorized_at`. In rewriting the function it dropped two predicates:
--
--   original:  and coalesce(b.earner_done, false)          ← deleted outright
--              and b.status in ('confirmed', 'completed')
--   live:      and b.status in ('completed', 'verified')   ← 'confirmed' → 'verified'
--
-- Both changes point the same way. `earner_done` was the whole definition of "the
-- work is done"; dropping it removes the condition the control is named after. And
-- the population at risk sits at `confirmed` — a booking only reaches `completed`
-- once BOTH parties mark done, which is precisely what an unresponsive poster has
-- not done. Swapping `confirmed` for `verified` traded the real population for one
-- that cannot exist: a verified booking's payment is `captured`, never `authorized`,
-- so that arm matches nothing at all.
--
-- Net effect: the control has reported green every hour for a week while the thing it
-- was written to see could not reach it. Found by a read-only payments audit on
-- 2026-08-12; verified here against the live pg_proc body before changing anything.
--
-- The authorized_at anchoring from 20260806150000 is CORRECT and is kept. Only the
-- two predicates come back.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_escrow_hold_expiring_work_done()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'booking_id', p.booking_id,
           'amount_cents', p.amount_cents,
           'booking_status', b.status,
           'earner_done', coalesce(b.earner_done, false),
           'poster_done', coalesce(b.poster_done, false),
           'earner_id', b.earner_id,
           'hold_placed_at', coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)),
           'hours_until_expiry', round(extract(epoch from
              (coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) + interval '7 days') - now()) / 3600.0, 1),
           'note', 'the earner finished this work and the hold is about to void — once '
                   'it does there is nothing left to capture and they are simply not paid')
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.status = 'authorized'
     -- THE DEFINITION OF "WORK DONE". Do not remove when re-creating this function.
     and coalesce(b.earner_done, false)
     -- 'confirmed' is the population at risk: a booking reaches 'completed' only when
     -- BOTH parties mark done, which is exactly what the absent poster has not done.
     and b.status in ('confirmed', 'completed')
     and coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) < now() - interval '5 days'
     and coalesce(p.authorized_at, greatest(p.created_at, p.cancelled_at)) >= now() - interval '8 days'
$$;

revoke execute on function public.ctl_escrow_hold_expiring_work_done() from public, anon, authenticated;

-- ── Assert the predicates are actually present ──────────────────────────────
-- Prose did not stop this being dropped once. The check runs against pg_proc, so it
-- describes the RUNNING function rather than what this file believes it wrote.
do $$
declare body text;
begin
  select pg_get_functiondef(oid) into body
    from pg_proc where proname = 'ctl_escrow_hold_expiring_work_done';
  if position('earner_done' in body) = 0 then
    raise exception 'the earner_done predicate is missing — this control watches nothing';
  end if;
  if position('''confirmed''' in body) = 0 then
    raise exception 'the confirmed status is missing — the at-risk population cannot match';
  end if;
  raise notice 'escrow-expiry control restored: watches confirmed/completed + earner_done';
end $$;
