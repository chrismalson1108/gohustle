-- ─────────────────────────────────────────────────────────────────────────────
-- The hourly sweep's stale-application expiry has never once cancelled a booking,
-- and the only reason nobody noticed is that the sweep swallows the error.
--
-- expire_stale_pending_bookings (20260812080000:105) is a plain SECURITY DEFINER
-- function whose whole body is `update public.bookings set status = 'cancelled'`.
-- That UPDATE fires trg_guard_bookings_write, and the live guard (20260730140000)
-- exempts exactly one caller — `coalesce(auth.role(), '') = 'service_role'` — then
-- routes on `auth.uid() = poster` / `auth.uid() = old.earner_id` and, failing both,
-- ends in `raise exception 'not authorized to modify this booking'`.
--
-- pg_cron runs the sweep as `select public.controls_sweep_and_page()`
-- (20260806030000:108) with no request.jwt.claims at all. SECURITY DEFINER changes
-- the DATABASE role, not the request claim, so auth.role() and auth.uid() are both
-- NULL inside the function: neither party branch matches and the guard raises —
-- but only on the hours when there is actually a row to expire, because a row-level
-- trigger does not fire on an UPDATE that matches nothing. So the sweep is silently
-- green until the exact moment it has work to do, and then
-- controls_sweep_and_page's `exception when others then raise warning 'stale
-- pending expiry failed: %'` (20260814070000:42) turns the failure into a line in
-- the Postgres log that nobody reads.
--
-- The only execution that has ever worked is the one-shot DO block in the migration
-- that introduced the function, and it worked for a reason stated at the top of that
-- same file: 20260812080000:14-20 sets a transaction-local service_role claim
-- precisely because "a migration carries no JWT — so without this the repairs below
-- either error ('not authorized to modify this booking') or, worse, report success
-- and silently change nothing". The function was given the workaround's benefit and
-- never the workaround.
--
-- WHAT IT COSTS. The application stays 'pending' forever, so
-- bookings_one_active_per_slot keeps job_slots.taken true and that hour is off the
-- market permanently; ctl_stranded_pending_booking and ctl_benefit_held_by_pending
-- open findings that can never self-heal; and any poster_discount or promo grant
-- consumed at APPLY stays spent by an application nobody accepted —
-- 20260817030000's header names this sweep as the thing that eventually releases it
-- ("self-heals when expire_stale_pending_bookings(14) cancels the application"),
-- and OPEN_WORK's consume-at-apply row leans on the same backstop. The backstop has
-- never run.
--
-- ── THE FIX, AND THE FIX NOT TAKEN ──────────────────────────────────────────
-- The function claims service_role for the duration of its own UPDATE and puts the
-- caller's claim back afterwards. Transaction-local (is_local => true), so it cannot
-- outlive the statement that called the sweep, and it is restored before
-- run_all_controls runs so no control is evaluated under a borrowed identity. A
-- raise cannot leak it either: a plpgsql subtransaction abort rolls GUC settings
-- back, which is what controls_sweep_and_page's exception block already is.
--
-- The alternative was to give guard_bookings_write the
-- `current_setting('request.jwt.claims', true) is null` bypass guard_jobs_delete
-- carries (20260625020000:127). Rejected: that guard's fallthrough is deny-by-default
-- on purpose — 20260730140000's own comment records that it used to be an UNPINNED
-- `return new` and that "only the two parties may ever update a booking" — and a
-- blanket claimless exemption would hand every future claimless path unpinned write
-- to every column of every booking, to fix one caller. Scope the exemption to the
-- caller that needs it.
--
-- A third route — an `app.*` escape hatch honoured by the guard, the way
-- raise_gig_emergency uses `app.emergency` (20260806180000:306) — is the closest thing
-- here to a house idiom, and it was rejected for the same reason: it means reproducing
-- two hundred lines of guard_bookings_write to add one line, and this repo has twice
-- lost a clause to exactly that kind of reproduction (supportGuardDrift.test.js and
-- ctl_ticket_rollup_stale both exist because of it). Nothing in the guard changes here.
--
-- Behaviour is otherwise IDENTICAL: body reproduced from 20260812080000 with the
-- claim swap wrapped around it and nothing else touched — same p_days default, same
-- three predicates (aged, started_at is null, no 'authorized' payment), same slot
-- recompute, same return.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.expire_stale_pending_bookings(p_days int default 14)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  prev text;
begin
  -- SECURITY DEFINER changes the database role; it does not change auth.role(),
  -- which guard_bookings_write reads from the request claim. From pg_cron there is
  -- no claim, so without this the UPDATE below raises 'not authorized to modify
  -- this booking' on exactly the hours it has a row to expire.
  --
  -- Narrow on purpose: claimed immediately before the write and handed back
  -- immediately after, so nothing else in the sweep — least of all run_all_controls —
  -- evaluates under it.
  prev := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

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
     -- No live hold at Stripe. Anything with money attached is a human's job.
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

  -- '' rather than NULL: auth.role()/auth.uid() both read the claim through
  -- `nullif(current_setting('request.jwt.claims', true), '')::jsonb`, so an empty
  -- string is indistinguishable from unset, whereas set_config(_, NULL, _) is not a
  -- reliable way to unset it. This is the same restore 20260812060000 and
  -- 20260813070000 use at the end of their probes.
  perform set_config('request.jwt.claims', coalesce(prev, ''), true);
  return n;
end;
$$;

revoke execute on function public.expire_stale_pending_bookings(int) from public, anon, authenticated;


-- ── Prove it discriminates: same staged row, cron's context, before and after ──
-- The whole finding is that the function works when a migration has already set a
-- claim and fails when cron has not, so a probe that runs under this file's own
-- service_role claim would prove nothing. The claim is CLEARED before either call.
do $$
declare
  uid uuid; jid uuid; sid uuid; bid uuid;
  n int; st text; slot_taken boolean;
  old_body_raised boolean := false;
  err text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'stale pending expiry probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- starts_at left null = "Flexible — Contact to Schedule", which is the shape most
  -- often ghosted and the one this sweep exists for.
  insert into public.job_slots (job_id, label) values (jid, 'Flexible — Contact to Schedule')
  returning id into sid;

  insert into public.bookings (job_id, earner_id, slot_id, status)
  values (jid, uid, sid, 'pending') returning id into bid;

  -- Aged past the window, no started_at, no authorized payment: exactly the row the
  -- function targets. trg_sync_slot_taken has already flagged the slot.
  update public.bookings set created_at = now() - interval '15 days' where id = bid;
  select taken into slot_taken from public.job_slots where id = sid;
  if not slot_taken then
    raise exception 'staging is wrong: the pending application did not take the slot';
  end if;

  -- ── pg_cron's context: no claim at all ────────────────────────────────────
  perform set_config('request.jwt.claims', '', true);
  if coalesce(auth.role(), '') = 'service_role' then
    raise exception 'staging is wrong: still service_role, so this proves nothing';
  end if;

  -- BEFORE: the old body was this bare UPDATE and nothing else. Under cron's context
  -- it does not expire the row — it raises, and the sweep logs a warning.
  begin
    update public.bookings set status = 'cancelled' where id = bid;
  exception when others then
    old_body_raised := true;
    err := sqlerrm;
  end;
  if not old_body_raised then
    raise exception 'the old body succeeded — the guard no longer blocks it and this fix is moot';
  end if;
  if err <> 'not authorized to modify this booking' then
    raise exception 'blocked, but by something else: %', err;
  end if;
  raise notice 'BEFORE: the unwrapped UPDATE raises "%" — this is what has run hourly since 2026-08-12', err;

  select status into st from public.bookings where id = bid;
  if st <> 'pending' then
    raise exception 'the failed update changed the row anyway (status %)', st;
  end if;

  -- AFTER: same row, same claimless context, through the new function.
  select public.expire_stale_pending_bookings(14) into n;
  if n <> 1 then
    raise exception 'FIX FAILED: expired % rows from cron''s context, expected 1', n;
  end if;
  select status into st from public.bookings where id = bid;
  if st <> 'cancelled' then
    raise exception 'FIX FAILED: reported 1 expiry but the row is still %', st;
  end if;
  select taken into slot_taken from public.job_slots where id = sid;
  if slot_taken then
    raise exception 'FIX FAILED: the booking was cancelled but the slot is still off the market';
  end if;
  raise notice 'AFTER: the same row expires and the slot returns to the market';

  -- The claim must not outlive the call. run_all_controls runs next in the same
  -- statement, and a leaked service_role identity would change what the controls see.
  if coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    raise exception 'the borrowed claim leaked out of the function: %',
      current_setting('request.jwt.claims', true);
  end if;
  raise notice 'the borrowed claim is handed back, so the rest of the sweep runs as itself';

  -- And it must still refuse the rows it is documented to refuse. Money and disputes
  -- are a human's job; a sweep that now works must not have become a sweep that
  -- tidies those away.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.bookings (job_id, earner_id, status)
  values (jid, uid, 'pending') returning id into bid;
  update public.bookings
     set created_at = now() - interval '30 days', started_at = now() - interval '29 days'
   where id = bid;
  perform set_config('request.jwt.claims', '', true);
  select public.expire_stale_pending_bookings(14) into n;
  if n <> 0 then
    raise exception 'expired a booking the earner had already started — that is a dispute, not litter';
  end if;
  select status into st from public.bookings where id = bid;
  if st <> 'pending' then
    raise exception 'a started application was cancelled by the sweep (status %)', st;
  end if;
  raise notice 'a started application is still left alone, so the scope did not widen';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'stale-pending-expiry probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
