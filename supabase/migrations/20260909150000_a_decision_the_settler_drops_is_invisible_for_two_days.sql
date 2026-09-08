-- `ctl_dispute_settlement_overdue` is CRITICAL and keys on the wrong clock.
--
-- It fires on `settle_after < now() - 2 hours`. That is the right due time for exactly one
-- of `dispute_settlement_pct`'s four branches — silence. For the other two that can be due
-- while `settle_after` is still in the FUTURE, the control is blind:
--
--   branch 1, an operator adjudicates. Setting `resolution_pct` makes the case due
--     immediately, but `settle_after` can be up to 48 hours out. So a decision the settler
--     fails to apply is invisible for up to ~50 hours while /disputes shows it as decided
--     and both parties have been told it is over.
--   branch 4, a contested case reaching the hold's age limit. Due at
--     `coalesce(authorized_at, created_at) + 5 days`, while `settle_after` may be as late
--     as hold + 6.5 days — a day and a half of silence on the branch that captures the
--     FULL amount without anybody reading the case.
--
-- This is the same class as the control it sits next to: a check that measures the wrong
-- thing reports green about a state nobody is watching. Measure lateness from when the
-- settlement actually became due.
--
-- Branch 1 needs a timestamp that did not exist. `decideDispute` deliberately does NOT
-- stamp `resolved_at` — that column unblocks earner-claim-payment, which captures in FULL
-- and would override the decision — so there was nothing recording WHEN a decision was
-- made. `decided_at` is that, and only that.

alter table public.disputes
  add column if not exists decided_at timestamptz;

comment on column public.disputes.decided_at is
  'When an operator set resolution_pct. NOT a settlement and NOT resolved_at — stamping '
  'resolved_at would unblock earner-claim-payment, which captures in full and would '
  'override the very decision being recorded (see /disputes actions). Exists so '
  'ctl_dispute_settlement_overdue can measure a decided case from when it became due '
  'rather than from settle_after, which may be up to 48h later. Service-role only.';

-- ── Pin it. LIVE body from pg_proc with two lines added, not a re-derivation ─────────
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
  -- 20260909140000: Stripe's own verdict on a card dispute. A party who could write this
  -- could tell the control a LOST chargeback was won.
  new.external_status:= old.external_status;
  -- 20260909150000: when an operator decided. A party who could move this could push a
  -- dropped settlement back out of the critical control's window.
  new.decided_at     := old.decided_at;

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

-- ── The control measures from when the money actually became due ─────────────────────
create or replace function public.ctl_dispute_settlement_overdue()
returns table(entity_id text, detail jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  -- `due_at` is computed in a LATERAL rather than a CTE that carries the row: a CTE row
  -- with an extra column is a `record` and cannot be cast back to `public.disputes`, which
  -- dispute_settlement_pct takes. So keep `d` a real table row throughout.
  select d.id::text,
         jsonb_build_object(
           'kind', 'settlement_overdue',
           'booking_id', d.booking_id,
           'due_pct', public.dispute_settlement_pct(d.*),
           'due_at', due.due_at,
           'settle_after', d.settle_after,
           'decided_at', d.decided_at,
           'why_due', case
                        when d.resolution_pct is not null then 'an operator decided it'
                        when d.responded_at is null then 'the reply window closed'
                        when d.response_stance = 'accept' then 'the worker accepted'
                        else 'contested, and the hold reached its age limit'
                      end,
           'hours_late', round(extract(epoch from (now() - due.due_at)) / 3600.0)::int,
           'remedy', 'The hourly settler has not paid a due dispute. Check /errors for '
                     || 'settle-disputes, then settle it from /disputes. If the Stripe '
                     || 'authorization lapses the earner is paid NOTHING.'
         )
    from public.disputes d
    left join public.payments p on p.booking_id = d.booking_id
    cross join lateral (
      select case
               -- An operator decided. Due the moment they did. decided_at is null on rows
               -- adjudicated before 20260909150000, so fall back to the old clock rather
               -- than reporting every historical decision as instantly overdue.
               when d.resolution_pct is not null then coalesce(d.decided_at, d.settle_after)
               -- Accepted: respond_to_dispute sets settle_after to now(), so it IS the due
               -- time. Silence: settle_after is the whole point of the window.
               when d.responded_at is null or d.response_stance = 'accept' then d.settle_after
               -- Contested and unadjudicated — branch 4, the full capture. Due on the
               -- hold's age, which can be a day and a half before settle_after.
               else coalesce(p.authorized_at, p.created_at) + interval '5 days'
             end as due_at
    ) due
   where d.pct_paid is null
     and public.dispute_settlement_pct(d.*) is not null
     and due.due_at < now() - interval '2 hours';
$function$;

-- ── And the notification names the real deadline ─────────────────────────────────────
--
-- Every user-facing description of branch 4 said the full capture happens "before the card
-- hold runs out" — day 7. It happens at coalesce(authorized_at, created_at) + 5 days. Two
-- days early, on the number the earner uses to decide whether replying is worth it. The
-- clients and the assistant prompt were corrected in the same commit; this is the server's
-- copy. Body otherwise reproduced from 20260909120000 unchanged.
create or replace function public.respond_to_dispute(
  p_dispute_id uuid,
  p_stance text,
  p_note text default null,
  p_photos text[] default '{}'
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d public.disputes;
  clean_photos text[];
begin
  if p_stance not in ('accept', 'contest') then
    raise exception 'stance must be accept or contest' using errcode = 'check_violation';
  end if;

  select * into d from public.disputes where id = p_dispute_id;
  if not found then
    raise exception 'dispute not found' using errcode = 'no_data_found';
  end if;
  if d.respondent_id is distinct from auth.uid() then
    raise exception 'not your dispute' using errcode = 'insufficient_privilege';
  end if;

  -- NOT EVERY disputes ROW IS AN ADJUSTMENT. A refund or chargeback record carries no
  -- proposed_pct; there is no percentage to accept and nothing to contest.
  if d.proposed_pct is null then
    raise exception 'this is a payment record, not an adjustment you can answer'
      using errcode = 'check_violation';
  end if;

  if d.responded_at is not null then
    raise exception 'you have already responded to this' using errcode = 'check_violation';
  end if;
  if d.pct_paid is not null then
    raise exception 'this has already been settled' using errcode = 'check_violation';
  end if;

  -- THE WINDOW IS THE WINDOW.
  if d.settle_after is not null and now() >= d.settle_after then
    raise exception '%', 'The reply window closed on '
      || to_char(d.settle_after at time zone 'UTC', 'Mon DD HH24:MI')
      || ' UTC, so this is being paid at ' || coalesce(d.proposed_pct, 100)::text || '%.'
      using errcode = 'check_violation';
  end if;

  clean_photos := coalesce((
    select array_agg(p) from unnest(coalesce(p_photos, '{}')) p
     where p like auth.uid()::text || '/%'
     limit 6
  ), '{}');

  perform set_config('app.dispute_response', p_dispute_id::text, true);

  update public.disputes
     set responded_at    = now(),
         response_stance = p_stance,
         response_note   = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
         response_photos = clean_photos,
         status          = case when p_stance = 'contest' then 'investigating' else status end,
         settle_after    = case when p_stance = 'accept' then now() else settle_after end
   where id = p_dispute_id;

  insert into public.notifications (user_id, type, title, body, job_id, data)
  select d.raised_by,
         'dispute',
         case when p_stance = 'accept' then 'They accepted your adjustment' else 'They disputed your report' end,
         case when p_stance = 'accept'
              then 'The worker accepted ' || coalesce(d.proposed_pct, 100)::text || '%. It will be paid shortly.'
              else 'The worker has responded and asked us to look at it. Nothing is paid while we do — '
                   || 'but if we have not decided within about five days of the payment being held, '
                   || 'the full amount is charged and paid to them.' end,
         j.id,
         jsonb_build_object('dispute_id', d.id, 'booking_id', d.booking_id)
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = d.booking_id;

  return true;
end;
$function$;

-- ── Probe ────────────────────────────────────────────────────────────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid; n int; body_text text; why text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 150000', 'Handyman', 200, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 20000, 1400, 18600, 'authorized', 'pi_probe_150000', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe 150000', 60) returning id into did;

  -- 1. AN OPERATOR DECIDES, and settle_after is still ~48h out. The old control keyed on
  --    settle_after and saw nothing for two days.
  update public.disputes
     set resolution_pct = 80, decided_at = now() - interval '5 hours'
   where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 1 then
    raise exception 'FIX FAILED: a decision the settler dropped 5h ago is still invisible (%)', n;
  end if;
  select detail->>'why_due' into why from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if why <> 'an operator decided it' then raise exception 'FIX FAILED: wrong reason — %', why; end if;

  -- …and a decision made 10 MINUTES ago is not overdue. The 2h grace still applies.
  update public.disputes set decided_at = now() - interval '10 minutes' where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 0 then raise exception 'FIX FAILED: a fresh decision reports as overdue (%)', n; end if;

  -- 2. CONTESTED, branch 4, hold past 5 days while settle_after is still ahead.
  update public.disputes set resolution_pct = null, decided_at = null,
                             responded_at = now() - interval '1 day', response_stance = 'contest',
                             status = 'investigating', settle_after = now() + interval '20 hours'
   where id = did;
  update public.payments set authorized_at = now() - interval '5 days 4 hours' where booking_id = bid;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 1 then raise exception 'FIX FAILED: branch 4 overdue is invisible (%)', n; end if;
  select detail->>'why_due' into why from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if why <> 'contested, and the hold reached its age limit' then
    raise exception 'FIX FAILED: wrong reason for branch 4 — %', why;
  end if;

  -- 3. SILENCE still behaves exactly as before — the one branch the old clock got right.
  update public.disputes set responded_at = null, response_stance = null, status = 'open',
                             settle_after = now() - interval '3 hours' where id = did;
  update public.payments set authorized_at = now() where booking_id = bid;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 1 then raise exception 'FIX FAILED: silence regressed (%)', n; end if;

  -- 4. …and a window that has NOT closed is still silent.
  update public.disputes set settle_after = now() + interval '10 hours' where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 0 then raise exception 'FIX FAILED: an open window reports as overdue (%)', n; end if;

  -- 5. The notification names five days, not the hold expiry.
  update public.disputes set settle_after = now() + interval '10 hours' where id = did;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  perform public.respond_to_dispute(did, 'contest', 'probe', '{}');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select body into body_text from public.notifications
   where (data->>'dispute_id') = did::text and user_id = poster order by created_at desc limit 1;
  if body_text like '%card hold runs out%' then
    raise exception 'FIX FAILED: the notice still names the hold expiry — %', left(body_text, 90);
  end if;
  if body_text not like '%five days%' then
    raise exception 'FIX FAILED: the notice does not name the real deadline — %', left(body_text, 90);
  end if;

  -- 6. decided_at is pinned against a party.
  update public.disputes set decided_at = now() - interval '5 hours' where id = did;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',poster::text)::text, true);
  update public.disputes set decided_at = now() + interval '10 days' where id = did;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if (select decided_at from public.disputes where id = did) > now() then
    raise exception 'FIX FAILED: a party can push a dropped settlement out of the window';
  end if;

  raise notice 'probe: decision/branch-4/silence all measured from when the money became due; notice names five days; decided_at pinned';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
