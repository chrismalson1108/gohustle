-- ─────────────────────────────────────────────────────────────────────────────
-- Clear the board: 16 open findings, almost all from before the platform had the
-- features their controls check for.
--
-- A controls board that is permanently red is one people stop reading, which is the
-- exact failure controls exist to prevent. Every finding below is either REPAIRED
-- (the data really is wrong) or the control is SCOPED (it was asking a question that
-- cannot apply to the row). Nothing is suppressed.
--
-- The dividing date is 2026-06-30: the first row in `payments`, i.e. the day escrow
-- began. Bookings from 2026-06-11 sit nineteen days before any payment could exist.
-- ─────────────────────────────────────────────────────────────────────────────

-- Claim service_role for THIS TRANSACTION. Several guards (guard_bookings_write,
-- guard_profiles_write, guard_support_ticket_write) exempt service_role and pin
-- columns for everyone else, and a migration carries no JWT — so without this the
-- repairs below either error ("not authorized to modify this booking") or, worse,
-- report success and silently change nothing, which is how the last two data fixes
-- in this repo failed. Transaction-local: it cannot leak past this file.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── 1. REPAIR: profiles.earnings_total ──────────────────────────────────────
-- Three profiles carry lifetime earnings that were typed in during pre-escrow manual
-- testing: $2,640.50 stored against $40.50 actually earned, plus $50 and $3 elsewhere.
-- Recomputed with the SAME expression ctl_earnings_total_drift uses to derive
-- `expected`, so the two agree by construction rather than by coincidence — credited
-- captures, plus credited tips, minus the earner's share of any refund.
--
-- This lowers displayed lifetime earnings on those profiles. That is the point: the
-- larger number was never money anyone received.
with credited as (
  select b.earner_id as uid, sum(coalesce(p.earner_amount_cents, 0))::bigint as cents
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where coalesce(p.earnings_credited, false)
   group by b.earner_id
),
tipped as (
  select t.earner_id as uid, sum(coalesce(t.amount_cents, 0))::bigint as cents
    from public.tip_ledger t
   where coalesce(t.credited, false) and t.earner_id is not null
   group by t.earner_id
),
clawed as (
  select b.earner_id as uid,
         sum(round(coalesce(p.refunded_cents, 0)::numeric
                   * coalesce(p.earner_amount_cents, 0)
                   / nullif(coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0), 0)))::bigint as cents
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where coalesce(p.refunded_cents, 0) > 0
     and coalesce(p.earnings_credited, false)
   group by b.earner_id
)
update public.profiles pr
   set earnings_total = round(
         greatest(0::bigint,
                  coalesce(c.cents, 0) + coalesce(t.cents, 0) - coalesce(r.cents, 0)
         )::numeric / 100, 2)
  from (select id from public.profiles) ids
  left join credited c on c.uid = ids.id
  left join tipped   t on t.uid = ids.id
  left join clawed   r on r.uid = ids.id
 where pr.id = ids.id
   and pr.earnings_total is distinct from round(
         greatest(0::bigint,
                  coalesce(c.cents, 0) + coalesce(t.cents, 0) - coalesce(r.cents, 0)
         )::numeric / 100, 2);

-- ── 2. REPAIR: job_slots.taken ──────────────────────────────────────────────
-- Two slots say "free" while carrying a live booking. Recomputed from the bookings
-- themselves, which are the source of truth — a slot flagged free but booked is how
-- a second person gets sold the same hour.
update public.job_slots s
   set taken = live.has
  from (
    select s2.id,
           exists (select 1 from public.bookings b
                    where b.slot_id = s2.id
                      and b.status in ('pending','confirmed','completed','verified')) as has
      from public.job_slots s2
  ) live
 where live.id = s.id
   and s.taken is distinct from live.has;

-- ── 3. REPAIR: an amendment unlock that outlived its booking ────────────────
-- amendment_status 'accepted' unlocks the poster's core job fields (EditJobScreen's
-- canEditCore). Left set on a booking that has already been verified, it is an edit
-- window on finished, paid work that nobody closed.
update public.bookings
   set amendment_status = 'none'
 where amendment_status = 'accepted'
   and status in ('verified','cancelled','declined');

-- ── 4. EXPIRE: pending bookings nobody ever answered ────────────────────────
-- Five pending bookings between 16 and 62 days old. This is a real product gap, not
-- just stale data: a poster who never responds leaves the earner waiting indefinitely
-- and keeps the slot flagged taken, so nobody else can book it either.
--
-- ONLY those holding no live authorization are expired here. A booking with an
-- 'authorized' payment has real money on a real card, and releasing that requires a
-- Stripe call this function cannot make — those keep firing the control for a human,
-- which is the correct outcome rather than a silent local status change that leaves
-- the hold stranded at Stripe.
create or replace function public.expire_stale_pending_bookings(p_days int default 14)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.bookings b
     set status = 'cancelled'
   where b.status = 'pending'
     and b.created_at < now() - make_interval(days => p_days)
     -- Nobody has touched it. One row here is 'pending' WITH started_at set — an
     -- earner who began work that was never accepted — and guard_bookings_write
     -- rightly refuses to cancel that ("open a dispute instead"). It is not
     -- abandoned, it is a real disagreement, and it should keep reaching a human
     -- through the control rather than being tidied away by a sweep.
     and b.started_at is null
     -- No live hold at Stripe. See above: anything with money attached is a human's job.
     and not exists (select 1 from public.payments p
                      where p.booking_id = b.id and p.status = 'authorized');
  get diagnostics n = row_count;

  -- Free the slots those bookings were holding.
  update public.job_slots s
     set taken = exists (select 1 from public.bookings b
                          where b.slot_id = s.id
                            and b.status in ('pending','confirmed','completed','verified'))
   where s.taken is distinct from exists (select 1 from public.bookings b
                          where b.slot_id = s.id
                            and b.status in ('pending','confirmed','completed','verified'));
  return n;
end;
$$;

revoke execute on function public.expire_stale_pending_bookings(int) from public, anon, authenticated;

do $$
declare n int;
begin
  select public.expire_stale_pending_bookings(14) into n;
  raise notice 'expired % stale pending booking(s)', n;
end $$;

-- ── 5. SCOPE: settled_without_captured_payment ──────────────────────────────
-- The two CRITICAL findings are bookings from 2026-06-11, nineteen days before the
-- first row in `payments`. They cannot have a captured payment because escrow did not
-- exist, so the control was asserting something unachievable and will assert it
-- forever. A permanently-red critical is worse than no critical: it trains everyone
-- to scroll past the row that will one day be real.
--
-- The floor is stated as a literal date rather than derived from min(created_at) in
-- payments, so it cannot drift if that table is ever pruned.
create or replace function public.ctl_settled_without_captured_payment()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'kind', case when p.id is null then 'completed_without_payment_row'
                        else 'settled_with_uncaptured_payment' end,
           'booking_status', b.status,
           'payment_id', p.id,
           'payment_status', p.status,
           'earner_id', b.earner_id,
           'poster_id', j.poster_id,
           'job_title', j.title,
           'earner_done', b.earner_done,
           'created_at', b.created_at)
    from public.bookings b
    join public.jobs j on j.id = b.job_id
    left join public.payments p on p.booking_id = b.id
   -- ESCROW LAUNCH. Before this date no booking could have a payment row.
   where b.created_at >= timestamptz '2026-06-30'
     and ((b.status = 'verified' and (p.id is null or p.status <> 'captured'))
       or (b.status in ('confirmed', 'completed')
           and p.id is null
           and coalesce(b.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'))
$$;

revoke execute on function public.ctl_settled_without_captured_payment() from public, anon, authenticated;

-- ── 6. CORRECT: live_booking_without_schedule_anchor ────────────────────────
-- Two problems with the old form, one of them a control bug.
--
-- (a) It read the anchor ONLY from job_slots.starts_at, ignoring bookings.starts_at —
--     which is the column the app also writes and the one a settlement sweep should
--     trust. A booking with its own anchor was reported as having none.
--
-- (b) It flagged "Flexible — Contact to Schedule" slots. Those carry no start time BY
--     DESIGN: PostJob attaches one when the poster picks no times, precisely so a gig
--     can never be un-bookable. Reporting the documented behaviour as a violation is
--     how a control loses its meaning.
--
-- What remains is the case actually worth catching: a live booking on a slot that was
-- meant to have a time and does not — including the orphan cases (missing slot, or a
-- slot belonging to a different job), which are real integrity breaks.
create or replace function public.ctl_live_booking_without_schedule_anchor()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id::text,
         jsonb_build_object(
           'reason', case
             when b.slot_id is null then 'no_slot_id'
             when s.id is null then 'slot_missing'
             when s.job_id <> b.job_id then 'slot_belongs_to_other_job'
             else 'slot_has_no_starts_at' end,
           'booking_status', b.status,
           'slot_id', b.slot_id,
           'slot_label', s.label,
           'job_id', b.job_id,
           'earner_id', b.earner_id,
           'created_at', b.created_at,
           'note', 'a live booking with no settlement anchor — flexible slots are '
                   'excluded because they carry no start time by design')
    from public.bookings b
    left join public.job_slots s on s.id = b.slot_id
   where b.status in ('confirmed','completed')
     -- The booking's own anchor counts. This is what the control missed.
     and b.starts_at is null
     and (b.slot_id is null
          or s.id is null
          or s.job_id <> b.job_id
          or (s.starts_at is null
              -- A flexible slot has no start time on purpose.
              and coalesce(s.label, '') <> 'Flexible — Contact to Schedule'))
$$;

revoke execute on function public.ctl_live_booking_without_schedule_anchor() from public, anon, authenticated;

-- ── Report what is left ─────────────────────────────────────────────────────
do $$
declare
  before_n int;
  after_n  int;
begin
  select count(*) into before_n from public.control_findings where resolved_at is null;
  perform public.run_all_controls();
  select count(*) into after_n from public.control_findings where resolved_at is null;
  raise notice 'open findings: % -> %', before_n, after_n;
end $$;
