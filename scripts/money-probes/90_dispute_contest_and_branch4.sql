-- The CONTESTED dispute path and branch 4, against the live rules. Rolled back.
--
-- Branch 4 is the promise the platform breaks in the earner's favour: a contested case
-- nobody adjudicates is captured in FULL once the authorization nears expiry. It is
-- deliberate — a partial capture cannot be topped up and a full one can be refunded — but
-- it has to actually work, fire at the right moment, and be visible to a human first.
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid;
  pct int; n int; msg text := '';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Contest probe', 'Handyman', 200, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 20000, 1400, 18600, 'authorized', 'pi_probe_contest', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe contest', 60) returning id into did;

  -- ── The earner CONTESTS ─────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  perform public.respond_to_dispute(did, 'contest', 'I did all of it', '{}');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select public.dispute_due_pct(did) into pct;
  select status into msg from public.disputes where id = did;
  msg := format(E'\n  contested -> status=%s, due_pct=%s (expect investigating / NULL: nothing is due yet)',
                msg, coalesce(pct::text,'NULL'));

  -- A contested row must NOT be settled by silence (branch 3 requires responded_at null).
  update public.disputes set settle_after = now() - interval '1 hour' where id = did;
  select public.dispute_due_pct(did) into pct;
  msg := msg || format(E'\n  window closed while contested -> due_pct=%s (expect NULL — silence must not settle a contest)',
                       coalesce(pct::text,'NULL'));

  -- ── Branch 4: the hold nears expiry with nobody adjudicating ────────────
  update public.payments set authorized_at = now() - interval '4 days' where booking_id = bid;
  select public.dispute_due_pct(did) into pct;
  msg := msg || format(E'\n  4 days after authorization -> due_pct=%s (expect NULL — branch 4 is 5 days)',
                       coalesce(pct::text,'NULL'));
  update public.payments set authorized_at = now() - interval '5 days 1 minute' where booking_id = bid;
  select public.dispute_due_pct(did) into pct;
  msg := msg || format(E'\n  5 days + 1 min          -> due_pct=%s (expect 100 — the earner is paid in FULL)',
                       coalesce(pct::text,'NULL'));

  -- ── Does a human hear about it BEFORE the receipt does? ────────────────
  update public.payments set authorized_at = now() - interval '2 days' where booking_id = bid;
  select count(*) into n from public.ctl_dispute_contested_unadjudicated() where entity_id = did::text;
  msg := msg || format(E'\n  at 2 days (3 before auto-capture): control fires %s', n);
  update public.payments set authorized_at = now() - interval '3 days 1 hour' where booking_id = bid;
  select count(*) into n from public.ctl_dispute_contested_unadjudicated() where entity_id = did::text;
  msg := msg || format(E'\n  at 3 days (2 before auto-capture): control fires %s (CLAUDE.md promises "two days before")', n);

  -- ── An OPERATOR adjudicates: bounded to [proposed_pct, 100] ────────────
  update public.disputes set resolution_pct = 80 where id = did;
  select public.dispute_due_pct(did) into pct;
  msg := msg || format(E'\n  operator sets 80%% -> due_pct=%s (branch 1 wins over branch 4)', pct);

  -- ── Can a respondent answer TWICE, or after settlement? ────────────────
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  begin
    perform public.respond_to_dispute(did, 'accept', 'changed my mind', '{}');
    msg := msg || E'\n  SECOND response ACCEPTED — a respondent can overwrite their own answer';
  exception when others then
    msg := msg || format(E'\n  second response refused: %s', sqlerrm);
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  raise exception E'CONTEST + BRANCH 4 PROBE (rolled back):%', msg;
end $$;
