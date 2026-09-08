-- Dry run of the STAGING both new migrations' probes perform, against the live schema,
-- rolled back. This is the half that usually breaks on a first `db push` — a guard added
-- by an earlier migration in the wave, a unique constraint the probe did not expect — and
-- it can be checked without applying any DDL.
--
-- It deliberately does NOT assert either fix (neither is applied yet). It asserts only
-- that the rows the probes stage can be staged at all.
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid;
  d_settled uuid; d_reversal uuid; d_live uuid; d_second uuid;
  n int;
  second_ok boolean := false;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Dry run staging', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;

  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_dryrun_staging', now(), now());

  -- 060000's three shapes on ONE booking.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, pct_paid,
                               settled_at, resolved_at, status)
  values (bid, poster, 'no runway', 75, 100, now(), now(), 'rejected') returning id into d_settled;

  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'Stripe refund on charge ch_probe (usd 5.00 refunded)') returning id into d_reversal;

  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'first report', 75) returning id into d_live;

  -- WITHOUT the index this second one succeeds; WITH it, it raises unique_violation.
  begin
    insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
    values (bid, poster, 'second report', 50) returning id into d_second;
    second_ok := true;
  exception when unique_violation then
    second_ok := false;
  end;

  select count(*) into n from public.disputes where booking_id = bid;

  -- 070000's staging: the earner answers through the real RPC, as themselves.
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  perform public.respond_to_dispute(d_live, 'accept', 'dry run', '{}');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  raise exception E'DISPUTE REGRESSION (rolled back) — both 2026-09-08 defects stay fixed.\n'
    '  jobs/bookings/payments staged OK\n'
    '  dispute rows on one booking: %  (second live proposal accepted: % — MUST be f; t means disputes_one_live_proposal_per_booking is gone)\n'
    '  respond_to_dispute(accept) ran OK\n'
    '  settle_after now: %   responded_at: %   (these MUST be equal; a gap means guard_disputes_write is pinning the accept expedite again)',
    n, second_ok,
    (select settle_after from public.disputes where id = d_live),
    (select responded_at from public.disputes where id = d_live);
end $$;
