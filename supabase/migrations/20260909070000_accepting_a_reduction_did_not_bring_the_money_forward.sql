-- Accepting a reduction was supposed to pay the earner at the next sweep. It didn't.
--
-- respond_to_dispute ends its UPDATE with
--
--     settle_after = case when p_stance = 'accept' then now() else settle_after end
--
-- and its own comment says why: "Accepting settles at the next sweep rather than waiting
-- out the clock." guard_disputes_write then pins `new.settle_after := old.settle_after`
-- UNCONDITIONALLY, four lines ABOVE the `if not responding then` block that lets the rest
-- of the response through. So the one write the accept path exists to make is the one
-- write the guard silently reverts.
--
-- The earner who agrees with the poster — the cooperative outcome the whole two-party
-- model is built to reward — is paid no sooner than the earner who says nothing. They
-- wait out the full window, up to 48 hours, having been told otherwise. And the poster is
-- told, by the server, in a durable inbox row: "The worker accepted 75%. It will be paid
-- shortly."
--
-- Silent, because the guard pins rather than raises: respond_to_dispute returns true, the
-- client toasts "This will be paid at the adjusted amount shortly", and every column the
-- screen re-reads afterwards (responded_at, response_stance, status) did land. Only the
-- clock did not move, and no screen shows it.
--
-- MEASURED AGAINST PRODUCTION, 2026-09-08, in a rolled-back transaction: staged a live
-- proposal, called respond_to_dispute(accept) as the earner through the real RPC, and read
-- the row back —
--
--     responded_at  2026-09-08 19:26:05+00
--     settle_after  2026-09-10 19:26:05+00
--
-- exactly 48 hours apart. The acceptance moved nothing. That is the BROKEN half of the
-- discrimination proof; the probe at the bottom of this file is the fixed half.
--
-- ── The fix is directional, not a hole ─────────────────────────────────────
--
-- settle_after cannot simply be added to the `if not responding` block. A respondent who
-- could write it freely could push their own deadline out indefinitely and hold the
-- poster's authorization until Stripe voids it — which pays NOBODY, the exact failure
-- ctl_dispute_settlement_overdue is critical about. So the exemption is one-directional:
-- while responding, settle_after may only move EARLIER. Anything at or past the existing
-- deadline is pinned back, so 'contest' (which does not touch it) and any attempt to
-- extend both land exactly where they do today.

create or replace function public.guard_disputes_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  responding boolean := coalesce(current_setting('app.dispute_response', true), '') = old.id::text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- Settlement, adjudication and provenance are server-side only, always.
  new.pct_paid       := old.pct_paid;
  new.settled_at     := old.settled_at;
  new.resolution_pct := old.resolution_pct;
  new.resolved_at    := old.resolved_at;
  new.resolved_by    := old.resolved_by;
  new.resolution_note:= old.resolution_note;
  new.assigned_to    := old.assigned_to;
  new.raised_by      := old.raised_by;
  new.booking_id     := old.booking_id;
  new.proposed_pct   := old.proposed_pct;
  new.respondent_id  := old.respondent_id;
  new.photos         := old.photos;
  new.reason         := old.reason;

  -- The deadline. Inside respond_to_dispute (and only for THIS row — the GUC carries the
  -- id) an accept may bring it forward; nothing may ever push it out. Outside, pinned.
  if responding then
    if new.settle_after is null or old.settle_after is null
       or new.settle_after > old.settle_after then
      new.settle_after := old.settle_after;
    end if;
  else
    new.settle_after := old.settle_after;
  end if;

  if not responding then
    new.responded_at    := old.responded_at;
    new.response_stance := old.response_stance;
    new.response_note   := old.response_note;
    new.response_photos := old.response_photos;
    new.status          := old.status;
  end if;

  return new;
end;
$function$;

-- ── The control: assert it against DATA, not against the guard ─────────────
--
-- An accepted reduction whose deadline still sits in the future after the acceptance
-- means the expedite was reverted again — by this guard, by a rewrite of
-- respond_to_dispute, or by anything else that learns to touch the column. Scoped to
-- unsettled rows so it names money that is still waiting rather than history.
create or replace function public.ctl_dispute_accept_not_expedited()
returns table(entity_id text, detail jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  select d.id::text,
         jsonb_build_object(
           'kind', 'accept_not_expedited',
           'booking_id', d.booking_id,
           'proposed_pct', d.proposed_pct,
           'responded_at', d.responded_at,
           'settle_after', d.settle_after,
           'hours_still_waiting', round(extract(epoch from (d.settle_after - now())) / 3600.0, 1),
           'remedy', 'This earner accepted the poster''s reduction and both were told it '
                     || 'would be paid shortly, but the settlement clock was never brought '
                     || 'forward, so settle-disputes will not pay it until the original '
                     || 'window closes. Check that guard_disputes_write still lets '
                     || 'respond_to_dispute move settle_after EARLIER while responding '
                     || '(20260909070000). To release this one now, set settle_after = now() '
                     || 'as service_role; the next sweep pays it at proposed_pct.'
         )
    from public.disputes d
   where d.response_stance = 'accept'
     and d.responded_at is not null
     and d.pct_paid is null
     and d.settle_after is not null
     and d.settle_after > d.responded_at + interval '5 minutes';
$function$;

revoke execute on function public.ctl_dispute_accept_not_expedited() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name)
values (
  'dispute_accept_not_expedited',
  'An accepted reduction is still waiting out the full clock',
  'high',
  'money',
  'respond_to_dispute brings settle_after forward on accept so the next hourly sweep pays '
  || 'it; guard_disputes_write pinned that write back unconditionally until 20260909070000. '
  || 'Both parties are told "it will be paid shortly" by the server, so a reverted expedite '
  || 'is a promise broken silently — nothing on either screen shows the clock.',
  'ctl_dispute_accept_not_expedited'
)
on conflict (key) do update
  set title = excluded.title, severity = excluded.severity, domain = excluded.domain,
      why = excluded.why, fn_name = excluded.fn_name;

-- ── Probe: broken vs fixed on the same staged row, then rolled back ────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid;
  before_after timestamptz; after_after timestamptz; responded timestamptz;
  findings int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 070000', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_070000', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe proposal', 75) returning id into did;

  select settle_after into before_after from public.disputes where id = did;
  if before_after <= now() + interval '1 hour' then
    raise exception 'probe staging wrong: expected a window well in the future, got %', before_after;
  end if;

  -- The earner accepts, through the real RPC, as themselves.
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  perform public.respond_to_dispute(did, 'accept', null, '{}');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select settle_after, responded_at into after_after, responded from public.disputes where id = did;

  -- BROKEN behaviour was: after_after = before_after (the pin reverted it).
  if after_after >= before_after then
    raise exception 'FIX FAILED: accepting did not bring settlement forward (still %)', after_after;
  end if;
  if after_after > responded + interval '5 minutes' then
    raise exception 'FIX FAILED: accepted row still waits % ', after_after - responded;
  end if;

  -- The control must be SILENT on the fixed row.
  select count(*) into findings from public.ctl_dispute_accept_not_expedited()
   where entity_id = did::text;
  if findings <> 0 then
    raise exception 'CONTROL WRONG: it fires on a correctly expedited acceptance';
  end if;

  -- And it must FIRE on the broken shape. Re-open the window as service_role, which is
  -- exactly what the pin used to leave behind.
  update public.disputes set settle_after = now() + interval '40 hours' where id = did;
  select count(*) into findings from public.ctl_dispute_accept_not_expedited()
   where entity_id = did::text;
  if findings <> 1 then
    raise exception 'CONTROL CANNOT DISCRIMINATE: it did not fire on a reverted expedite';
  end if;

  -- A CONTESTED row must not be caught by any of this.
  update public.disputes
     set response_stance = 'contest', settle_after = now() + interval '40 hours'
   where id = did;
  select count(*) into findings from public.ctl_dispute_accept_not_expedited()
   where entity_id = did::text;
  if findings <> 0 then
    raise exception 'CONTROL WRONG: it fires on a contested dispute, which keeps its clock';
  end if;

  raise notice 'probe: accept expedites, the control discriminates, contest is untouched';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
