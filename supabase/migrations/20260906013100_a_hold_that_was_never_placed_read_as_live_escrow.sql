-- ─────────────────────────────────────────────────────────────────────────────
-- payments said escrow was held from the instant the PaymentIntent was CREATED —
-- before any card had been authorized — and nothing ever corrected it.
--
-- stripe-create-payment-intent minted a manual-capture PI with no payment method and no
-- confirm (Stripe state: `requires_payment_method`, holding nothing) and immediately
-- upserted `status: 'authorized', authorized_at: now()`. Its own heal branch refuses
-- exactly that write for exactly that Stripe state, and says why: "Writing 'authorized'
-- for a PI still awaiting a payment method would tell expire_stale_pending_bookings and
-- ctl_escrow_hold_lapsed_uncancelled that escrow exists when it does not." The create
-- path did it for every intent.
--
-- A poster who opens "Accept & pay" and swipes the sheet away leaves that row behind.
-- Both clients treat a dismissal as "not a real error" and cancel nothing (GigsScreen:
-- `if (payErr.code !== 'Canceled')`), and Stripe fires no webhook on abandonment. So:
--
--   · expire_stale_pending_bookings(14) skipped the booking forever — its whole point is
--     "anything with money attached is a human's job", and it read a live hold;
--   · sync_slot_taken kept the slot taken for a pending booking, so no other earner
--     could book it;
--   · the earner sat in Awaiting indefinitely with no way to tell;
--   · at eight days ctl_escrow_hold_lapsed_uncancelled opened a CRITICAL finding saying
--     a hold had LAPSED — on a hold that was never placed;
--   · reconcile-stripe filed hold_dead_at_stripe hourly and wrote nothing back.
--
-- ── THE FIX: a pre-authorization state ───────────────────────────────────────
-- 'pending' means "an intent exists, nothing is held". Every consumer already reads it
-- correctly, because they all spell "money is held" as `status = 'authorized'`: the
-- 14-day sweep, both escrow-age controls, the dashboard's escrow_held_cents,
-- reconcile-stripe's dead-hold check and guard_bookings_write's escrow invariant. The
-- webhook already named 'pending' in two of its own predicates before the value existed.
--
-- The promotion to 'authorized' happens ONLY on an observed `requires_capture`:
-- accept-booking on the normal path, and a new payment_intent.amount_capturable_updated
-- handler on the recovery re-hold, where accept-booking refuses to run at all because
-- the booking is no longer 'pending'. That window was already documented in
-- stripe-create-payment-intent as leaving no trace anywhere; it now has a watcher.
--
-- Found by the money-edge-escrow audit pass, 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The status is representable ──────────────────────────────────────────
-- The CHECK is an inline, auto-named constraint from supabase/migration_stripe.sql, so
-- find it rather than guessing the name.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payments'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
       and pg_get_constraintdef(oid) ilike '%authorized%'
  loop
    execute format('alter table public.payments drop constraint %I', c.conname);
  end loop;

  alter table public.payments add constraint payments_status_check
    check (status in ('pending', 'authorized', 'captured', 'cancelled', 'failed'));
end $$;

comment on column public.payments.status is
  'pending = a PaymentIntent exists and NOTHING is held (created, not yet confirmed by '
  'the poster) · authorized = an observed requires_capture, real money on a real card · '
  'captured · cancelled · failed. Only "authorized" means escrow exists; every consumer '
  'that asks "is money held?" must spell it that way.';

-- The DEFAULT stays 'authorized' deliberately: it is only reachable by an INSERT that
-- omits the column, which no writer does, and changing it would silently re-point any
-- legacy path at the new state without anyone deciding to.


-- ── 2. A live booking with no escrow behind it ──────────────────────────────
-- The state the fix makes visible instead of mislabelling. Two ways to reach it, and
-- both need a human:
--
--   (a) the recovery re-hold on a completed booking was abandoned — the work is DONE and
--       there is no money to capture, which neither party can see (stripe-capture-payment
--       and earner-claim-payment both answer HOLD_EXPIRED);
--   (b) the poster DID complete it, but payment_intent.amount_capturable_updated never
--       arrived — the subscription is missing, or the delivery failed — so real money is
--       held against a row that says otherwise, and settlement is refused.
--
-- Neither is covered elsewhere. ctl_escrow_hold_lapsed_uncancelled and
-- ctl_escrow_expiring_soon both filter to status='authorized' and so are blind by
-- construction; ctl_stranded_pending_booking only looks at bookings still 'pending'.
create or replace function public.ctl_hold_never_confirmed_on_live_booking()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$
  select p.id::text as entity_id,
         jsonb_build_object(
           'booking_id', p.booking_id,
           'booking_status', b.status,
           'earner_id', b.earner_id,
           'earner_done', coalesce(b.earner_done, false),
           'poster_id', j.poster_id,
           'job_id', b.job_id,
           'payment_intent_id', p.payment_intent_id,
           'amount_cents', p.amount_cents,
           'age_hours', round(extract(epoch from now() - coalesce(p.authorized_at, p.created_at)) / 3600.0, 1),
           'note', 'this booking is live — accepted, or the work is already done — and its '
                   'payments row says the card hold was never completed, so nothing is in '
                   'escrow. Either the poster abandoned a recovery re-hold (the earner has '
                   'worked and there is no money to capture), or they finished it and the '
                   'payment_intent.amount_capturable_updated event never reached us, in '
                   'which case real money IS held and settlement is being refused against '
                   'it. Both sides are told the same nothing: stripe-capture-payment and '
                   'earner-claim-payment answer HOLD_EXPIRED.',
           'remedy', 'Retrieve the PaymentIntent at Stripe. requires_capture ⇒ the hold is '
                     'real; check the account webhook is subscribed to '
                     'payment_intent.amount_capturable_updated (reconcile-stripe asserts '
                     'this) and let the redelivery promote the row. Anything else ⇒ no '
                     'money was ever held: ask the poster to accept and pay again, which '
                     'mints a fresh hold on the same booking.'
         ) as detail
    from public.payments p
    join public.bookings b on b.id = p.booking_id
    join public.jobs j on j.id = b.job_id
   where p.status = 'pending'
     -- A 'pending' row under a still-'pending' BOOKING is the ordinary abandoned pay
     -- sheet. That one now self-heals: expire_stale_pending_bookings(14) can finally
     -- see it, cancels the application and frees the slot. Only a booking that is
     -- already live has work riding on money that is not there.
     and b.status in ('confirmed', 'completed', 'verified')
     and coalesce(p.authorized_at, p.created_at) < now() - interval '24 hours'
$ctl$;

revoke execute on function public.ctl_hold_never_confirmed_on_live_booking() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('hold_never_confirmed_on_live_booking',
   'Accepted booking whose card hold was never completed',
   'high', 'money',
   'payments.status = ''pending'' means a PaymentIntent exists and nothing is held. On a '
   'live booking that is either work being done with no escrow behind it (an abandoned '
   'recovery re-hold), or real money held against a row that does not know it because '
   'payment_intent.amount_capturable_updated never arrived — and in that second case '
   'both stripe-capture-payment and earner-claim-payment refuse to settle. The escrow '
   'controls cannot see either: they filter to status = ''authorized'' by construction, '
   'which is exactly why the create path used to write ''authorized'' for a hold that '
   'did not exist.',
   'ctl_hold_never_confirmed_on_live_booking')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove the constraint, the sweep and the control all changed behaviour ───
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid; sid uuid;
  jid2 uuid; bid2 uuid;
  n_new int; n_old int; n_expired int; bstatus text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- (1) The status is writable at all. Before this migration the CHECK rejected it, so
  -- there was NO way to say "an intent exists and nothing is held".
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'unconfirmed hold probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'completed')
  returning id into bid;

  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     status, authorized_at)
  values (bid, 'pi_probe_pending_' || replace(bid::text, '-', ''), 10000, 700, 9300,
          'pending', now())
  returning id into pid;
  raise notice 'a pre-authorization state is representable; the CHECK used to refuse it';

  -- ...and the enum is still closed. A typo must not become a new silent state.
  begin
    update public.payments set status = 'authorised' where id = pid;
    raise exception 'FIX FAILED: the status CHECK now admits arbitrary values';
  exception when check_violation then
    update public.payments set status = 'pending' where id = pid;
    raise notice 'the status set is still closed — only the five known values';
  end;

  -- (2) Fresh: silent. A poster mid-sheet must not put a row on the board.
  select count(*) into n_new
    from public.ctl_hold_never_confirmed_on_live_booking() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'fired within the hour on a live pay sheet — permanent noise (% rows)', n_new;
  end if;
  raise notice 'a hold placed moments ago is silent, so a normal acceptance never flickers';

  -- (3) Aged past 24h on a COMPLETED booking: the work is done and no money is held.
  update public.payments set authorized_at = now() - interval '30 hours' where id = pid;
  select count(*) into n_new
    from public.ctl_hold_never_confirmed_on_live_booking() where entity_id = pid::text;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a 30-hour unconfirmed hold on completed work reported % rows', n_new;
  end if;

  -- THE DISCRIMINATION. Age it to nine days and ask the control that USED to speak for
  -- this row. It is blind to 'pending' — which is the point: while this row said
  -- 'authorized' it fired CRITICAL claiming a hold had LAPSED, on a hold never placed.
  update public.payments set authorized_at = now() - interval '9 days' where id = pid;
  select count(*) into n_old
    from public.ctl_escrow_hold_lapsed_uncancelled() where entity_id = pid::text;
  if n_old <> 0 then
    raise exception 'ctl_escrow_hold_lapsed_uncancelled still claims this hold lapsed';
  end if;
  select count(*) into n_new
    from public.ctl_hold_never_confirmed_on_live_booking() where entity_id = pid::text;
  raise notice 'discriminates: new control reports the true state (% row), ctl_escrow_hold_lapsed_uncancelled reports % — it used to open a CRITICAL "hold lapsed" here', n_new, n_old;

  -- And the same row AS 'authorized' is exactly what that control is for, so the two
  -- swap cleanly rather than one going dark.
  update public.payments set status = 'authorized' where id = pid;
  select count(*) into n_old
    from public.ctl_escrow_hold_lapsed_uncancelled() where entity_id = pid::text;
  if n_old <> 1 then
    raise exception 'a genuinely lapsed 9-day hold is no longer reported (% rows)', n_old;
  end if;
  select count(*) into n_new
    from public.ctl_hold_never_confirmed_on_live_booking() where entity_id = pid::text;
  if n_new <> 0 then
    raise exception 'the new control fires on a real hold, which is not its job (% rows)', n_new;
  end if;
  raise notice 'a real lapsed hold still reaches its own control and not this one';

  -- (4) THE SWEEP. The abandoned pay sheet on a still-pending booking: 'authorized'
  -- made expire_stale_pending_bookings skip it forever.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'abandoned sheet probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid2;
  insert into public.job_slots (job_id, label) values (jid2, 'Flexible — Contact to Schedule')
  returning id into sid;
  insert into public.bookings (job_id, earner_id, slot_id, status, created_at)
  values (jid2, uid, sid, 'pending', now() - interval '30 days')
  returning id into bid2;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents, status)
  values (bid2, 'pi_probe_abandoned_' || replace(bid2::text, '-', ''), 10000, 700, 9300, 'authorized');

  perform public.expire_stale_pending_bookings(14);
  select status into bstatus from public.bookings where id = bid2;
  if bstatus <> 'pending' then
    raise exception 'the sweep expired a booking with a live hold — that is a human''s job';
  end if;
  raise notice 'BROKEN: with the row reading "authorized", a 30-day abandoned application survives the 14-day sweep';

  -- The same row, honestly labelled.
  update public.payments set status = 'pending' where booking_id = bid2;
  select public.expire_stale_pending_bookings(14) into n_expired;
  select status into bstatus from public.bookings where id = bid2;
  if bstatus <> 'cancelled' then
    raise exception 'FIX FAILED: a 30-day application with no hold is still not expired (status %)', bstatus;
  end if;
  if (select taken from public.job_slots where id = sid) then
    raise exception 'FIX FAILED: the slot is still taken, so nobody else can book it';
  end if;
  raise notice 'FIXED: the same application now expires and frees its slot (% expired this pass)', n_expired;

  if not exists (select 1 from public.controls
                  where key = 'hold_never_confirmed_on_live_booking' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'unconfirmed-hold probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
