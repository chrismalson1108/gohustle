-- ─────────────────────────────────────────────────────────────────────────────
-- The accused party had no way to answer, because the money had already moved.
--
-- Reported by a tester, and he is exactly right:
--
--   "Picture and reporting issue needs a place for both people to respond … Let's
--    say you pay to fix door A, then report an issue and post an issue on door B.
--    Worker should be able to say 'no that's door B, we worked on door A'."
--
-- What happens today, in order, inside ONE request from the poster's phone:
--   1. photos upload
--   2. stripe.paymentIntents.capture  ← the money moves HERE
--   3. payments row flipped to 'captured'
--   4. the earner's earnings are credited at the reduced amount
--   5. promo budget settled
--   6. the `disputes` row is INSERTED — about eighty lines after the capture
--   7. bookings.status := 'verified'
--   8. the earner is notified, last, by a fire-and-forget push from the POSTER's
--      client that is never retried
--
-- So the record exists to document a decision that has already been executed, and
-- Stripe has already released the uncaptured remainder to the poster. Nothing in
-- this repo can pay an earner MORE after a partial capture: `stripe.transfers.create`
-- appears nowhere, and the capture path refuses any payment that is not `authorized`.
-- A right of reply arriving after that is not a right of reply.
--
-- Two further facts make it worse than it sounds. The earner cannot read the
-- accusation at all — `disputes_select_parties` grants them SELECT, and
-- 20260906059000 was written SPECIFICALLY so "the accused earner" could open the
-- photos, with a post-deploy assertion — but no screen on either client has ever
-- issued the query. And filing the dispute REMOVES their only self-service lever:
-- earner-claim-payment refuses any booking carrying an unresolved dispute.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- The poster's tap becomes a PROPOSAL, not a settlement. The authorization is left
-- standing, so the escrow hold is still there to be the remedy when somebody
-- decides. The earner is told by the SERVER, with the reason and the photos, and
-- has 48 hours to accept or contest. Then money moves on a clock:
--
--   1. an operator decided          → their percentage
--   2. the earner accepted          → the proposed percentage
--   3. the earner said nothing      → the proposed percentage (silence stands)
--   4. contested, nobody adjudicated, and the hold is running out → ONE HUNDRED
--
-- Rule 4 is not a fairness heuristic. It is an asymmetry of the tooling: a partial
-- capture cannot be topped up, and a full capture CAN be refunded
-- (admin-payment-action, idempotent in four layers). When the platform fails to
-- adjudicate in time it must err in the only direction it can walk back.
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ───────────────────────────────────────
--
--   • The status vocabulary. 'open' means awaiting a response and 'investigating'
--     means contested, both already in the CHECK — so `vest_bonuses`, which gates a
--     third party's referral bonus on `status in ('open','investigating')`, keeps
--     covering both new states without being re-typed. Widening the CHECK would
--     have forced a rewrite of that function, of ctl_dispute_resolution_desync and
--     of every console pill.
--   • A full-pay verification (pct = 1). It still captures synchronously, in the
--     same request, exactly as today. Nothing about the happy path is slower.
--   • No dispute_messages table, no second thread. One reply each is what the
--     tester described; anything longer is the support thread, which exists, and
--     which openThreadWithUser already accepts a booking id for.
--
-- Idempotent. Ends with a rolled-back probe that stages one dispute and asserts all
-- four settlement branches, the guard, the response RPC and every control.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Columns ─────────────────────────────────────────────────────────────────
alter table public.disputes
  -- What the poster ASKED for. pct_paid stays "what was actually collected" and
  -- remains null until settlement, so the two can never be confused — the console
  -- used to render pct_paid as the proposal, which was only true because the two
  -- happened in the same breath.
  add column if not exists proposed_pct     integer,
  -- The counterparty, resolved once at insert rather than re-joined through
  -- booking→job at every read site.
  add column if not exists respondent_id    uuid references public.profiles(id) on delete set null,
  add column if not exists settle_after     timestamptz,
  add column if not exists responded_at     timestamptz,
  add column if not exists response_stance  text,
  add column if not exists response_note    text,
  add column if not exists response_photos  text[] not null default '{}',
  -- An operator's decision. Bounded to [proposed_pct, 100] by the console action:
  -- adjudication may only ever move money TOWARD the earner, because moving it the
  -- other way is the one direction that cannot be undone.
  add column if not exists resolution_pct   integer,
  add column if not exists settled_at       timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'disputes_proposed_pct_chk') then
    alter table public.disputes add constraint disputes_proposed_pct_chk
      check (proposed_pct is null or (proposed_pct >= 50 and proposed_pct <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'disputes_resolution_pct_chk') then
    alter table public.disputes add constraint disputes_resolution_pct_chk
      check (resolution_pct is null or (resolution_pct >= 0 and resolution_pct <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'disputes_response_stance_chk') then
    alter table public.disputes add constraint disputes_response_stance_chk
      check (response_stance is null or response_stance in ('accept', 'contest'));
  end if;
end $$;

-- The settler's own predicate, so the hourly sweep is an index scan.
create index if not exists disputes_unsettled_idx on public.disputes (settle_after)
  where pct_paid is null;

comment on column public.disputes.proposed_pct is
  'What the poster asked to pay, 50-100. pct_paid is what was actually collected and '
  'stays NULL until settlement — never read one for the other.';

-- ── The outcome rule, in ONE place ──────────────────────────────────────────
-- Every consumer — the settler, the console, the controls, the probe — asks this
-- function. The alternative is the same four branches written out in an edge
-- function, a console action and a sweep query, drifting independently; that is
-- the shape platform_fee_cents exists to prevent on the fee.
--
-- Returns NULL when the dispute is not yet due, which is what the settler tests.
create or replace function public.dispute_settlement_pct(d public.disputes)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  auth_at timestamptz;
begin
  -- Already settled: nothing to decide.
  if d.pct_paid is not null then return null; end if;

  -- 1. An operator decided. Highest precedence — a human looked at both sides.
  if d.resolution_pct is not null then return d.resolution_pct; end if;

  -- 2. The earner accepted the proposal.
  if d.response_stance = 'accept' then return coalesce(d.proposed_pct, 100); end if;

  -- 3. The earner said nothing and the window has closed. Silence stands.
  if d.responded_at is null and d.settle_after is not null and now() >= d.settle_after then
    return coalesce(d.proposed_pct, 100);
  end if;

  -- 4. Contested, nobody adjudicated, and the authorization is running out.
  --    Stripe cancels an uncaptured manual PaymentIntent at about seven days, and a
  --    lapsed authorization pays NOBODY — strictly worse for the earner than any
  --    outcome here. So at five days we capture in full, which is the only direction
  --    this codebase can reverse (admin-payment-action refund).
  if d.response_stance = 'contest' then
    select p.created_at into auth_at
      from public.payments p
     where p.booking_id = d.booking_id
     order by p.created_at desc
     limit 1;
    if auth_at is not null and now() >= auth_at + interval '5 days' then
      return 100;
    end if;
  end if;

  -- Not due.
  return null;
end;
$$;

revoke execute on function public.dispute_settlement_pct(public.disputes) from public, anon, authenticated;
grant execute on function public.dispute_settlement_pct(public.disputes) to service_role;

-- ── Defaults at insert ──────────────────────────────────────────────────────
create or replace function public.dispute_set_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b_earner uuid;
  j_poster uuid;
begin
  select b.earner_id, j.poster_id into b_earner, j_poster
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  -- Whoever is NOT the raiser. Resolved once, here, so no read site has to re-join.
  if new.respondent_id is null then
    new.respondent_id := case when new.raised_by = j_poster then b_earner else j_poster end;
  end if;

  -- 48 hours to answer. Chosen by the founder over 72 so a gig finished on Friday
  -- still settles over the weekend rather than on Monday.
  if new.settle_after is null then
    new.settle_after := now() + interval '48 hours';
  end if;

  return new;
end;
$$;

revoke execute on function public.dispute_set_defaults() from public, anon, authenticated;

drop trigger if exists trg_a_dispute_defaults on public.disputes;
create trigger trg_a_dispute_defaults
  before insert on public.disputes
  for each row execute function public.dispute_set_defaults();

-- ── The notice, written by the SERVER ───────────────────────────────────────
-- Today the earner's only notice is an unawaited fetch from the poster's client
-- (JobsContext.js:954-960) that returns false on any failure and is never retried.
-- If the poster's app is killed after the booking write, the money is gone and the
-- earner is told nothing at all.
--
-- The inbox row is durable, is in the realtime publication (20260906110000), and is
-- written in the same transaction as the dispute. The push stays best-effort from
-- the client: there is no database→push rail here, the same constraint the safety
-- nudge documents.
create or replace function public.dispute_notify_respondent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j_title text;
  j_id    uuid;
begin
  select j.title, j.id into j_title, j_id
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  if new.respondent_id is not null then
    insert into public.notifications (user_id, type, title, body, job_id, data)
    values (
      new.respondent_id,
      'dispute',
      'The poster reported a problem',
      'They have asked to pay ' || coalesce(new.proposed_pct, 100)::text || '% on '
        || coalesce(j_title, 'your gig')
        || '. You have 48 hours to reply before that goes through — open it to see why and respond.',
      j_id,
      jsonb_build_object('dispute_id', new.id, 'booking_id', new.booking_id, 'tab', 'EarnTab')
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.dispute_notify_respondent() from public, anon, authenticated;

drop trigger if exists trg_z_dispute_notify on public.disputes;
create trigger trg_z_dispute_notify
  after insert on public.disputes
  for each row execute function public.dispute_notify_respondent();

-- ── Write guard ─────────────────────────────────────────────────────────────
-- disputes_insert_party lets either party INSERT, and nothing has ever pinned the
-- columns. Without this, an earner could PATCH their own resolution_pct to 100, or a
-- poster could rewrite proposed_pct after the earner accepted.
--
-- The response columns are writable only inside respond_to_dispute(), which names
-- THIS dispute in the GUC. Keying the exemption to the row's own id rather than a
-- bare 'on' means the flag cannot be set once and used to rewrite a different
-- dispute in the same transaction — a strictly better version of the
-- app.support_reopen pattern it copies.
create or replace function public.guard_disputes_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
  new.settle_after   := old.settle_after;
  new.photos         := old.photos;
  new.reason         := old.reason;

  if not responding then
    new.responded_at    := old.responded_at;
    new.response_stance := old.response_stance;
    new.response_note   := old.response_note;
    new.response_photos := old.response_photos;
    new.status          := old.status;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_disputes_write() from public, anon, authenticated;

drop trigger if exists trg_guard_disputes_write on public.disputes;
create trigger trg_guard_disputes_write
  before update on public.disputes
  for each row execute function public.guard_disputes_write();

-- ── The earner's read path ──────────────────────────────────────────────────
-- A definer RPC rather than a policy change, for one reason beyond convenience:
-- `disputes_select_parties` exposes assigned_to and resolved_by to both parties,
-- which are STAFF user ids (OPEN_WORK.md records this as an open leak). A whitelisted
-- column set closes that as a side effect of building the screen the earner needs.
create or replace function public.my_dispute(p_booking_id uuid)
returns table (
  id uuid, booking_id uuid, raised_by uuid, reason text, photos text[],
  proposed_pct integer, pct_paid numeric, status text,
  respondent_id uuid, settle_after timestamptz,
  responded_at timestamptz, response_stance text, response_note text, response_photos text[],
  resolution_pct integer, resolution_note text, resolved_at timestamptz,
  settled_at timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.booking_id, d.raised_by, d.reason, d.photos,
         d.proposed_pct, d.pct_paid, d.status,
         d.respondent_id, d.settle_after,
         d.responded_at, d.response_stance, d.response_note, d.response_photos,
         d.resolution_pct, d.resolution_note, d.resolved_at,
         d.settled_at, d.created_at
    from public.disputes d
   where d.booking_id = p_booking_id
     -- Party check through private.is_booking_party, NOT a join on public.jobs — a
     -- policy subquery runs as the querying role and would inherit jobs_select_all,
     -- so a suspended poster's job disappears and their counterparty loses the
     -- dispute they are in the middle of (20260906041000).
     and private.is_booking_party(d.booking_id, auth.uid());
$$;

revoke execute on function public.my_dispute(uuid) from public, anon;
grant execute on function public.my_dispute(uuid) to authenticated;

-- ── The response ────────────────────────────────────────────────────────────
create or replace function public.respond_to_dispute(
  p_dispute_id uuid,
  p_stance     text,
  p_note       text default null,
  p_photos     text[] default '{}'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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
  -- Only the accused, and only while it is still open. Not the raiser: they had
  -- their say when they proposed.
  if d.respondent_id is distinct from auth.uid() then
    raise exception 'not your dispute' using errcode = 'insufficient_privilege';
  end if;
  if d.responded_at is not null then
    raise exception 'you have already responded to this' using errcode = 'check_violation';
  end if;
  if d.pct_paid is not null then
    raise exception 'this has already been settled' using errcode = 'check_violation';
  end if;

  -- Same rule the poster's photos get: only the caller's own storage prefix. A
  -- respondent who could name any path would pull another user's private photos into
  -- a record support reads.
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
         -- 'investigating' is the EXISTING enum value for contested, deliberately —
         -- see the header. vest_bonuses already treats it as unresolved.
         status          = case when p_stance = 'contest' then 'investigating' else status end,
         -- Accepting settles at the next sweep rather than waiting out the clock.
         settle_after    = case when p_stance = 'accept' then now() else settle_after end
   where id = p_dispute_id;

  -- Tell the RAISER their counterparty answered, so a contest is not something they
  -- have to go looking for.
  insert into public.notifications (user_id, type, title, body, job_id, data)
  select d.raised_by,
         'dispute',
         case when p_stance = 'accept' then 'They accepted your adjustment' else 'They disputed your report' end,
         case when p_stance = 'accept'
              then 'The worker accepted ' || coalesce(d.proposed_pct, 100)::text || '%. It will be paid shortly.'
              else 'The worker has responded and asked us to look at it. Nothing is paid until we do.' end,
         j.id,
         jsonb_build_object('dispute_id', d.id, 'booking_id', d.booking_id)
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = d.booking_id;

  return true;
end;
$$;

revoke execute on function public.respond_to_dispute(uuid, text, text, text[]) from public, anon;
grant execute on function public.respond_to_dispute(uuid, text, text, text[]) to authenticated;

-- ── Controls ────────────────────────────────────────────────────────────────

-- 1. CRITICAL. The settler is now the only thing that pays a held gig, which makes
--    it a new single point of silence — the same shape as expire_stale_pending_bookings,
--    which shipped without a service_role claim and never once ran from cron for three
--    weeks while its own `exception when others then raise warning` hid it. The failure
--    here is not a reduced payout: it is the authorization LAPSING and the earner being
--    paid nothing at all.
create or replace function public.ctl_dispute_settlement_overdue()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select d.id::text,
         jsonb_build_object(
           'kind', 'settlement_overdue',
           'booking_id', d.booking_id,
           'due_pct', public.dispute_settlement_pct(d.*),
           'settle_after', d.settle_after,
           'hours_late', round(extract(epoch from (now() - d.settle_after)) / 3600.0)::int,
           'remedy', 'The hourly settler has not paid a due dispute. Check /errors for '
                     || 'settle-disputes, then settle it from /disputes. If the Stripe '
                     || 'authorization lapses the earner is paid NOTHING.'
         )
    from public.disputes d
   where d.pct_paid is null
     and public.dispute_settlement_pct(d.*) is not null
     and d.settle_after < now() - interval '2 hours';
$$;

-- 2. HIGH. The whole design in one predicate, asserted against DATA: a reduced
--    payment exists and the dispute records no route by which the earner could have
--    been heard — no acceptance, no expired window, no operator decision.
create or replace function public.ctl_dispute_reduction_without_consent()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select d.id::text,
         jsonb_build_object(
           'kind', 'reduction_without_consent',
           'booking_id', d.booking_id,
           'pct_paid', d.pct_paid,
           'responded_at', d.responded_at,
           'response_stance', d.response_stance,
           'resolution_pct', d.resolution_pct,
           'settle_after', d.settle_after,
           'remedy', 'Somebody was paid less than the full amount without accepting, '
                     || 'without the response window closing, and without an operator '
                     || 'deciding. Find out which code path did it before anything else.'
         )
    from public.disputes d
   where d.pct_paid is not null
     and d.pct_paid < 100
     and d.resolution_pct is null
     and coalesce(d.response_stance, '') <> 'accept'
     and (d.settle_after is null or d.settled_at is null or d.settled_at < d.settle_after);
$$;

-- 3. MEDIUM. Asserted against the notifications table rather than a flag column: a
--    `notified_at` boolean would only ever prove that the writer set its own flag.
create or replace function public.ctl_dispute_notice_missing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select d.id::text,
         jsonb_build_object(
           'kind', 'respondent_never_told',
           'booking_id', d.booking_id,
           'respondent_id', d.respondent_id,
           'created_at', d.created_at,
           'remedy', 'A dispute exists and its respondent has no inbox notice. They are '
                     || 'being timed out of a window they were never told about — extend '
                     || 'settle_after and tell them before it settles.'
         )
    from public.disputes d
   where d.respondent_id is not null
     and d.created_at < now() - interval '30 minutes'
     and not exists (
       select 1 from public.notifications n
        where n.user_id = d.respondent_id
          and n.type = 'dispute'
          and n.data->>'dispute_id' = d.id::text
     );
$$;

revoke execute on function public.ctl_dispute_settlement_overdue() from public, anon, authenticated;
revoke execute on function public.ctl_dispute_reduction_without_consent() from public, anon, authenticated;
revoke execute on function public.ctl_dispute_notice_missing() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('dispute_settlement_overdue',
   'A dispute is due to be paid and the settler has not paid it',
   'critical', 'money',
   'Holding the escrow instead of capturing on the poster''s tap is what makes a reply '
   'meaningful, and it makes the hourly settler the only thing that pays a held gig. '
   'That is a new single point of silence, and it is the shape expire_stale_pending_bookings '
   'already demonstrated: shipped without a service_role claim, hidden by its own '
   '`exception when others then raise warning`, and never ran from cron for three weeks. '
   'The failure mode is not a reduced payout — it is the Stripe authorization lapsing at '
   'about seven days, after which the earner is paid NOTHING and no code here can pay them.',
   'ctl_dispute_settlement_overdue'),

  ('dispute_reduction_without_consent',
   'Somebody was paid less than full without accepting, timing out, or being adjudicated',
   'high', 'money',
   'The entire point of this design in one predicate, tested against data rather than '
   'against the settler having been written correctly. There are exactly three routes to '
   'a reduced payout — the earner accepted, the 48-hour window closed on silence, or an '
   'operator decided — and a reduced payment carrying none of them means some other code '
   'path captured money the earner never had a chance to answer, which is the defect this '
   'whole migration exists to remove.',
   'ctl_dispute_reduction_without_consent'),

  ('dispute_notice_missing',
   'A dispute respondent was never told it exists',
   'medium', 'integrity',
   'The 48-hour window is only fair if the person can see the clock. The notice is written '
   'by an AFTER INSERT trigger in the same transaction as the dispute, so a gap means the '
   'trigger was dropped or the insert bypassed it — and the person is being timed out of a '
   'window they were never told about. Asserted by joining notifications rather than by '
   'reading a notified_at flag, which would only prove the writer set its own column.',
   'ctl_dispute_notice_missing')
on conflict (key) do update
  set title = excluded.title, severity = excluded.severity, domain = excluded.domain,
      why = excluded.why, fn_name = excluded.fn_name;

-- ── Probe ───────────────────────────────────────────────────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; pid uuid; did uuid;
  pct int; n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then
    raise notice 'probe skipped — needs two profiles';
    raise exception 'probe complete — rolling back';
  end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe door A', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_dispute', now()) returning id into pid;

  -- A proposal: 75%, nothing captured yet.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, photos)
  values (bid, poster, 'wrong door', 75, '{}') returning id into did;

  -- Defaults landed.
  if (select respondent_id from public.disputes where id = did) <> earner then
    raise exception 'FIX FAILED: respondent_id did not resolve to the earner';
  end if;
  if (select settle_after from public.disputes where id = did) is null then
    raise exception 'FIX FAILED: settle_after was not stamped';
  end if;

  -- The notice exists, and the control agrees.
  if not exists (select 1 from public.notifications
                  where user_id = earner and data->>'dispute_id' = did::text) then
    raise exception 'FIX FAILED: the respondent was not notified';
  end if;
  update public.disputes set created_at = now() - interval '1 hour' where id = did;
  select count(*) into n from public.ctl_dispute_notice_missing() where entity_id = did::text;
  if n <> 0 then raise exception 'FIX FAILED: notice-missing fires on a dispute that WAS notified'; end if;
  delete from public.notifications where data->>'dispute_id' = did::text;
  select count(*) into n from public.ctl_dispute_notice_missing() where entity_id = did::text;
  if n <> 1 then raise exception 'FIX FAILED: notice-missing did not fire when the notice was gone'; end if;
  raise notice 'ctl_dispute_notice_missing discriminates';

  -- BRANCH: not due yet.
  update public.disputes set created_at = now(), settle_after = now() + interval '48 hours' where id = did;
  select public.dispute_settlement_pct(d.*) into pct from public.disputes d where d.id = did;
  if pct is not null then raise exception 'FIX FAILED: settled early, got %', pct; end if;

  -- BRANCH 3: silence past the window → the proposal stands.
  update public.disputes set settle_after = now() - interval '1 minute' where id = did;
  select public.dispute_settlement_pct(d.*) into pct from public.disputes d where d.id = did;
  if pct <> 75 then raise exception 'FIX FAILED: silence should settle at 75, got %', pct; end if;

  -- BRANCH 2: the earner accepts.
  perform set_config('request.jwt.claims',
    json_build_object('sub', earner::text, 'role', 'authenticated')::text, true);
  perform public.respond_to_dispute(did, 'accept', 'fine by me');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select public.dispute_settlement_pct(d.*) into pct from public.disputes d where d.id = did;
  if pct <> 75 then raise exception 'FIX FAILED: accept should settle at 75, got %', pct; end if;
  if (select response_stance from public.disputes where id = did) <> 'accept' then
    raise exception 'FIX FAILED: the stance was not recorded';
  end if;

  -- One response only.
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', earner::text, 'role', 'authenticated')::text, true);
    perform public.respond_to_dispute(did, 'contest', 'changed my mind');
    raise exception 'FIX FAILED: a second response was accepted';
  exception when check_violation then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  end;

  -- BRANCH 4: contested, nobody adjudicated, the hold is old → 100.
  update public.disputes
     set response_stance = 'contest', responded_at = now(), status = 'investigating'
   where id = did;
  select public.dispute_settlement_pct(d.*) into pct from public.disputes d where d.id = did;
  if pct is not null then raise exception 'FIX FAILED: a fresh contest settled at %, expected to wait', pct; end if;
  update public.payments set created_at = now() - interval '6 days' where id = pid;
  select public.dispute_settlement_pct(d.*) into pct from public.disputes d where d.id = did;
  if pct <> 100 then raise exception 'FIX FAILED: a stale contest should settle at 100, got %', pct; end if;

  -- BRANCH 1: an operator decides, and it outranks everything.
  update public.disputes set resolution_pct = 90 where id = did;
  select public.dispute_settlement_pct(d.*) into pct from public.disputes d where d.id = did;
  if pct <> 90 then raise exception 'FIX FAILED: the operator decision was not honoured, got %', pct; end if;
  raise notice 'all four settlement branches discriminate';

  -- The overdue control sees a due-and-unpaid dispute, and goes quiet once paid.
  update public.disputes set settle_after = now() - interval '5 hours' where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 1 then raise exception 'FIX FAILED: settlement-overdue did not fire'; end if;
  update public.disputes set pct_paid = 90, settled_at = now() where id = did;
  select count(*) into n from public.ctl_dispute_settlement_overdue() where entity_id = did::text;
  if n <> 0 then raise exception 'FIX FAILED: settlement-overdue still fires after settlement'; end if;
  raise notice 'ctl_dispute_settlement_overdue discriminates';

  -- Consent control: a reduction with an operator decision is fine…
  select count(*) into n from public.ctl_dispute_reduction_without_consent() where entity_id = did::text;
  if n <> 0 then raise exception 'FIX FAILED: consent control fires on an adjudicated reduction'; end if;
  -- …and a reduction with no route at all is not.
  update public.disputes
     set resolution_pct = null, response_stance = null, responded_at = null,
         pct_paid = 50, settled_at = now(), settle_after = now() + interval '10 hours'
   where id = did;
  select count(*) into n from public.ctl_dispute_reduction_without_consent() where entity_id = did::text;
  if n <> 1 then raise exception 'FIX FAILED: consent control missed an unconsented reduction'; end if;
  raise notice 'ctl_dispute_reduction_without_consent discriminates';

  -- The guard: a party cannot award themselves money.
  perform set_config('request.jwt.claims',
    json_build_object('sub', earner::text, 'role', 'authenticated')::text, true);
  update public.disputes set resolution_pct = 100, pct_paid = 100 where id = did;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if (select resolution_pct from public.disputes where id = did) is not null then
    raise exception 'FIX FAILED: the earner set their own resolution_pct';
  end if;
  if (select pct_paid from public.disputes where id = did) <> 50 then
    raise exception 'FIX FAILED: the earner rewrote pct_paid';
  end if;
  raise notice 'guard_disputes_write pins settlement and adjudication';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'dispute probe passed — all changes rolled back';
  else
    raise;
  end if;
end $$;
