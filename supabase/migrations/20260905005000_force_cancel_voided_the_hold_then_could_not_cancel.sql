-- ─────────────────────────────────────────────────────────────────────────────
-- The console's Force cancel voided the poster's escrow hold and then could not
-- cancel the booking, because the guard it hits has no operator bypass.
--
-- guard_started_booking_cancel (20260629190000:26) raises whenever
-- `new.status = 'cancelled' and old.started_at is not null`. That rule is correct and
-- must stay: it is what stops either PARTY walking away from work that is under way,
-- and stripe-cancel-payment mirrors it with its own 409.
--
-- What it lacks is the `service_role` early return every sibling guard opens with —
-- guard_bookings_write (20260730140000:49) and guard_min_age (20260710040000:29) both
-- return immediately for service_role, on the stated principle that these guards
-- constrain the two parties, not the operator sitting in the console with an audited
-- reason and a step-up factor.
--
-- The cost of that omission was not "Force cancel is unavailable". It was money:
--
--   admin/app/(console)/bookings/actions.ts forceCancel released the escrow hold FIRST
--   (a real, irreversible stripe.paymentIntents.cancel via admin-payment-action) and
--   only then wrote bookings.status = 'cancelled'. On any booking where the earner had
--   tapped "I'm on site", that write raised — so the authorization was gone from
--   Stripe, payments.status read 'cancelled', and the BOOKING stayed confirmed or
--   completed and live for both parties with nothing behind it. Capture, settle and
--   earner-claim-payment were all impossible from that point, and NO control looks for
--   that shape: ctl_settled_without_captured_payment only fires on a confirmed/completed
--   booking with NO payments row, and this one has a row.
--
-- Two halves, and this file is one of them:
--   * the console now writes the booking BEFORE it touches Stripe, so a refusal costs
--     nothing (same order JobsContext.cancelBooking has always used);
--   * this migration gives the operator override the bypass its siblings have, so the
--     override the console offers actually works instead of failing on every started
--     booking.
--
-- BLAST RADIUS. The only service-role writer of bookings.status = 'cancelled' in the
-- whole tree is that console action — stripe-webhook, admin-payment-action and
-- stripe-create-payment-intent each write only `payments`, and
-- expire_stale_pending_bookings runs under pg_cron where auth.role() is null and is
-- therefore untouched (it also only ever touches never-started pending rows). Parties
-- are unaffected: authenticated callers still hit the raise, which the probe proves on
-- the same staged row.
--
-- Nothing else in the function changes. Idempotent (create or replace); the trigger is
-- left exactly as 20260629190000 created it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_started_booking_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- THE FIX. Same early return, same reasoning, as guard_bookings_write and
  -- guard_min_age: this guard binds the earner and the poster. An operator cancelling
  -- from the console has already passed requireFreshAdmin('finance'), written a reason
  -- into admin_audit_log, and is doing it precisely because the normal path is stuck.
  -- Without this the console voided the hold and then could not cancel the booking.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if new.status = 'cancelled' and old.started_at is not null then
    raise exception 'Cannot cancel a job that has already started — open a dispute instead.';
  end if;
  return new;
end;
$$;

-- Trigger functions must not be directly callable by clients.
revoke execute on function public.guard_started_booking_cancel() from public, anon, authenticated;


-- ── Prove it discriminates on ONE staged row ────────────────────────────────
-- Same booking, same started_at, both roles: the operator gets through, the party does
-- not. Before this migration the first half raised too, which is the whole finding.
do $$
declare
  uid uuid; jid uuid; bid uuid; started timestamptz; blocked boolean := false; msg text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'started-cancel guard probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- A CONFIRMED booking the earner has started. This is the exact row the console's
  -- Force cancel used to void money against and then fail to write.
  insert into public.bookings (job_id, earner_id, status, started_at)
  values (jid, uid, 'confirmed', now() - interval '1 hour')
  returning id, started_at into bid, started;

  if started is null then
    raise exception 'staged row is not started — the probe would prove nothing';
  end if;
  raise notice 'staged a confirmed booking with started_at set: the old rule raised on exactly this shape';

  -- HALF ONE — the operator. This is what was broken.
  update public.bookings set status = 'cancelled' where id = bid;
  if (select status from public.bookings where id = bid) <> 'cancelled' then
    raise exception 'FIX FAILED: the console override still cannot cancel a started booking';
  end if;
  raise notice 'operator (service_role) cancelled the started booking — the override works';

  -- HALF TWO — a PARTY, on the same row. The guard must still bite, or this migration
  -- would have deleted the control instead of scoping it.
  update public.bookings set status = 'confirmed' where id = bid;
  perform set_config(
    'request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text,
    true);
  begin
    update public.bookings set status = 'cancelled' where id = bid;
  exception when others then
    blocked := true;
    msg := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if not blocked then
    raise exception 'REGRESSION: a party cancelled a started booking — the guard is now toothless';
  end if;
  if msg not like '%already started%' then
    raise exception 'the party was blocked, but by something else: %', msg;
  end if;
  raise notice 'a party is still refused on the same row (%) — the guard is scoped, not removed', msg;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'started-cancel guard probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
