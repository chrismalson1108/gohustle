-- ─────────────────────────────────────────────────────────────────────────────
-- Four defects in yesterday's dispute model, all found by auditing it rather than
-- by running it. Each is small; each breaks the model in a way nothing would have
-- reported.
--
-- 1. THE CLOCK IS ANCHORED TO THE WRONG COLUMN. Branch 4 dates the authorization
--    from `payments.created_at`. That is the FIRST hold ever placed on the booking;
--    20260806150000 exists precisely to say so, and `stripe-create-payment-intent`
--    upserts on booking_id, leaves created_at alone and writes `authorized_at` on a
--    re-hold. Every other hold-age reader in this repo already uses
--    coalesce(authorized_at, created_at). This one did not, so a re-held booking
--    could be judged "the hold is expiring" days before it is — and capture in full.
--
-- 2. THE REPLY WINDOW IGNORED THE HOLD IT DEPENDS ON. A flat 48 hours, stamped
--    without looking at how much life the authorization had left.
--    stripe-capture-payment admits a proposal at 36 hours of runway, so a hold aged
--    into [120h, 132h] got a window that closes AFTER Stripe voids the
--    authorization: the earner answers into a void and nobody is paid at all. The
--    window is now derived from the hold — 48 hours, or 12 hours before the
--    authorization dies, whichever comes first — so it can never outlive the money
--    it is a window on.
--
-- 3. NOT EVERY `disputes` ROW IS AN ADJUSTMENT. stripe-webhook's recordReversal
--    files a bare row for a refund or a chargeback: booking_id, raised_by, reason,
--    and no proposed_pct. Yesterday's triggers gave that row a respondent, a
--    48-hour clock and a server-authored accusation reading "They have asked to pay
--    100% … you have 48 hours to reply" — sent to an earner nobody accused. Then
--    branch 3 would settle it at 100% on silence and stamp resolved_at, auto-closing
--    the very row that exists to BLOCK earner-claim-payment while a reversal is
--    unexplained. `proposed_pct is not null` is the whole difference and is now the
--    predicate: a reversal row gets a respondent (useful) and nothing else — no
--    clock, no notice, and dispute_settlement_pct returns null for it forever.
--
-- 4. THE ACCUSER COULD NOT SEE THE REBUTTAL. `completion_party_read` unnests
--    `disputes.photos` and stops. `response_photos` arrived a day later and appears
--    in no policy, while respond_to_dispute stores them under the RESPONDENT's own
--    folder — so the earner passed the owner branch and the poster passed nothing.
--    Both clients and the console render them to the poster regardless, and
--    SignedImage degrades a refused signature to a grey rectangle. The case file was
--    silently one-sided for the person being answered.
--
-- Plus a control for the failure the model deliberately accepts: a contested case
-- nobody adjudicates is captured IN FULL when the hold runs out. That is the right
-- default — it is the only direction admin-payment-action can reverse — but it
-- should never be the first time a human hears about the case.
--
-- Idempotent. Ends with a rolled-back probe that stages the reversal row, the
-- short-runway hold and the rebuttal photo, and asserts each fix discriminates.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The outcome rule, re-anchored ────────────────────────────────────────
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
  if d.pct_paid is not null then return null; end if;

  -- 1. An operator decided. Highest precedence — a human looked at both sides.
  if d.resolution_pct is not null then return d.resolution_pct; end if;

  -- 2. The earner accepted the proposal.
  if d.response_stance = 'accept' then return coalesce(d.proposed_pct, 100); end if;

  -- 3. The earner said nothing and the window has closed. Silence stands.
  --    settle_after is NULL on a row that is not an adjustment (see the header),
  --    which is what keeps a refund/chargeback row out of the settler forever.
  if d.responded_at is null and d.settle_after is not null and now() >= d.settle_after then
    return coalesce(d.proposed_pct, 100);
  end if;

  -- 4. Contested, nobody adjudicated, and the authorization is running out.
  --    coalesce(authorized_at, created_at): created_at is the FIRST hold ever placed
  --    on this booking and a recovery re-hold deliberately leaves it alone
  --    (20260806150000). Reading it here judged a fresh hold by an old clock.
  if d.response_stance = 'contest' then
    select coalesce(p.authorized_at, p.created_at) into auth_at
      from public.payments p
     where p.booking_id = d.booking_id
     order by p.created_at desc
     limit 1;
    if auth_at is not null and now() >= auth_at + interval '5 days' then
      return 100;
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function public.dispute_settlement_pct(public.disputes) from public, anon, authenticated;
grant execute on function public.dispute_settlement_pct(public.disputes) to service_role;

-- ── 2 + 3. Defaults: a window bounded by the money, and only for adjustments ──
create or replace function public.dispute_set_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b_earner uuid;
  j_poster uuid;
  hold_dies timestamptz;
begin
  select b.earner_id, j.poster_id into b_earner, j_poster
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  -- Resolved once, here, so no read site has to re-join. Useful on every row,
  -- including a reversal: it names the counterparty either way.
  if new.respondent_id is null then
    new.respondent_id := case when new.raised_by = j_poster then b_earner else j_poster end;
  end if;

  -- ONLY an adjustment gets a clock. A row with no proposed_pct is a refund or a
  -- chargeback record filed by stripe-webhook; giving it a window armed branch 3,
  -- which would settle and auto-close the row whose whole job is to stay open.
  if new.proposed_pct is not null and new.settle_after is null then
    select coalesce(p.authorized_at, p.created_at) + interval '7 days' into hold_dies
      from public.payments p
     where p.booking_id = new.booking_id
     order by p.created_at desc
     limit 1;

    -- 48 hours — chosen over 72 so a gig finished on Friday still settles over the
    -- weekend — but never past the point where the authorization can still pay
    -- anybody. A window that closes after the hold dies is a window onto nothing:
    -- the earner answers, the settler tries to capture, and Stripe has already
    -- voided it. 12 hours of margin covers the hourly sweep plus a retry.
    new.settle_after := least(
      now() + interval '48 hours',
      coalesce(hold_dies - interval '12 hours', now() + interval '48 hours')
    );
    -- Never backwards: a hold already inside its last 12 hours would otherwise be
    -- given a window in the past, which reads as "the reply window has closed"
    -- before the earner has been told anything.
    if new.settle_after <= now() then
      new.settle_after := now() + interval '1 hour';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.dispute_set_defaults() from public, anon, authenticated;

-- ── 3 (cont). The notice is an accusation. Only send it when there IS one ────
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
  -- A reversal row accuses nobody. Telling an earner "they have asked to pay 100%,
  -- you have 48 hours to reply" about a chargeback the poster's bank raised is a
  -- false accusation written by us, over our own signature, with a clock on it.
  if new.proposed_pct is null then return new; end if;

  select j.title, j.id into j_title, j_id
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  if new.respondent_id is not null then
    insert into public.notifications (user_id, type, title, body, job_id, data)
    values (
      new.respondent_id,
      'dispute',
      'The poster reported a problem',
      'They have asked to pay ' || new.proposed_pct::text || '% on '
        || coalesce(j_title, 'your gig')
        || '. You have until '
        || to_char(coalesce(new.settle_after, now() + interval '48 hours') at time zone 'UTC',
                   'Mon DD HH24:MI') || ' UTC to reply before that goes through — '
        || 'open it to see why and respond.',
      j_id,
      jsonb_build_object('dispute_id', new.id, 'booking_id', new.booking_id, 'tab', 'EarnTab')
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.dispute_notify_respondent() from public, anon, authenticated;

-- ── 4. The rebuttal photographs, visible to the person being rebutted ───────
drop policy if exists "completion_party_read" on storage.objects;

create policy "completion_party_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'completion-photos'
    and (
      -- The uploader owns their "<uid>/…" folder.
      (storage.foldername(name))[1] = auth.uid()::text
      -- Either party of a booking that references this object as proof of work.
      or exists (
        select 1
        from public.bookings b
        cross join lateral unnest(
          coalesce(b.completion_photos, '{}'::text[]) || coalesce(b.before_photos, '{}'::text[])
        ) as photo(val)
        where private.is_booking_party(b.id, auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
      -- Either party of a booking whose DISPUTE references this object — the
      -- accusation's photos AND the answer's. The answer half was missing, and
      -- respond_to_dispute stores those under the RESPONDENT's own folder, so the
      -- accuser passed no branch and saw a grey rectangle where the rebuttal was.
      -- Same is_booking_party route, so suspending either party cannot hide the
      -- evidence from the person it is being used against.
      or exists (
        select 1
        from public.disputes d
        join public.bookings b on b.id = d.booking_id
        cross join lateral unnest(
          coalesce(d.photos, '{}'::text[]) || coalesce(d.response_photos, '{}'::text[])
        ) as photo(val)
        where private.is_booking_party(b.id, auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
    )
  );

-- ── A contested case must not be decided by a timeout in silence ────────────
-- Branch 4 is deliberate and stays: a partial capture cannot be topped up, a full
-- one can be refunded, and a lapsed hold pays nobody. But it is the platform failing
-- to do the thing it promised, and the first a human hears of it should not be the
-- receipt. Fires from 48 hours before the auto-capture, so there is a working day.
create or replace function public.ctl_dispute_contested_unadjudicated()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select d.id::text,
         jsonb_build_object(
           'kind', 'contested_unadjudicated',
           'booking_id', d.booking_id,
           'proposed_pct', d.proposed_pct,
           'responded_at', d.responded_at,
           'auto_capture_at', coalesce(p.authorized_at, p.created_at) + interval '5 days',
           'hours_left', greatest(0, round(extract(epoch from (
              coalesce(p.authorized_at, p.created_at) + interval '5 days' - now())) / 3600.0)::int),
           'remedy', 'The earner disputed this and nobody has decided. Open /disputes and '
                     || 'settle it. If nothing is decided the platform captures the FULL '
                     || 'amount when the hold runs out — refundable, but it is us breaking '
                     || 'the promise both clients make that a person reads the case.'
         )
    from public.disputes d
    join public.payments p on p.booking_id = d.booking_id
   where d.pct_paid is null
     and d.resolution_pct is null
     and d.response_stance = 'contest'
     and now() >= coalesce(p.authorized_at, p.created_at) + interval '3 days';
$$;

revoke execute on function public.ctl_dispute_contested_unadjudicated() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('dispute_contested_unadjudicated',
   'A contested dispute is heading for an automatic full capture',
   'high', 'money',
   'Both clients tell the earner a person reads the case before any money moves. '
   || 'dispute_settlement_pct branch 4 captures in full without one when the hold nears '
   || 'expiry. That default is correct and irreversible-in-the-safe-direction, but it '
   || 'must never be the first time anybody looks at the case.',
   'ctl_dispute_contested_unadjudicated')
on conflict (key) do update set
  title = excluded.title, severity = excluded.severity, domain = excluded.domain,
  why = excluded.why, fn_name = excluded.fn_name;

-- ── Probe ───────────────────────────────────────────────────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid; rid uuid;
  n int; sa timestamptz; body text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 040000', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;

  -- A hold placed 6 days ago on the ledger, RE-HELD 1 hour ago. The old code read
  -- created_at and would have called this expiring.
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_040000',
          now() - interval '6 days', now() - interval '1 hour');

  -- (3) A REVERSAL row: no proposed_pct.
  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'chargeback recorded') returning id into rid;
  if (select settle_after from public.disputes where id = rid) is not null then
    raise exception 'FIX FAILED: a reversal row was given a reply clock';
  end if;
  if exists (select 1 from public.notifications where data->>'dispute_id' = rid::text) then
    raise exception 'FIX FAILED: a reversal row sent the earner an accusation';
  end if;
  if (select public.dispute_settlement_pct(d.*) from public.disputes d where d.id = rid) is not null then
    raise exception 'FIX FAILED: the settler would settle a reversal row';
  end if;
  if (select respondent_id from public.disputes where id = rid) <> earner then
    raise exception 'FIX FAILED: a reversal row lost its respondent';
  end if;
  delete from public.disputes where id = rid;

  -- (2) An ADJUSTMENT gets a clock, bounded by the hold.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, photos)
  values (bid, poster, 'wrong door', 75, '{}') returning id into did;
  select settle_after into sa from public.disputes where id = did;
  if sa is null then raise exception 'FIX FAILED: an adjustment got no clock'; end if;
  if sa > now() + interval '48 hours' + interval '1 minute' then
    raise exception 'FIX FAILED: window longer than 48h (%)', sa;
  end if;
  -- The hold dies 7 days after authorized_at (1 hour ago), so 48h is the binding
  -- limit here and the window is the full 48 hours.
  if sa < now() + interval '47 hours' then
    raise exception 'FIX FAILED: a fresh hold was given a short window (%)', sa;
  end if;

  -- (1) Branch 4 must read authorized_at. created_at is 6 days old; authorized_at is
  -- 1 hour old. Contested → NOT due.
  update public.disputes set response_stance = 'contest', responded_at = now() where id = did;
  if (select public.dispute_settlement_pct(d.*) from public.disputes d where d.id = did) is not null then
    raise exception 'FIX FAILED: branch 4 fired on a hold that was re-authorized an hour ago';
  end if;
  -- Age the CURRENT hold past 5 days and it must fire.
  update public.payments set authorized_at = now() - interval '6 days' where booking_id = bid;
  if (select public.dispute_settlement_pct(d.*) from public.disputes d where d.id = did) <> 100 then
    raise exception 'FIX FAILED: branch 4 did not fire on a genuinely expiring hold';
  end if;

  -- The new control sees it, and stops seeing it once a human decides.
  select count(*) into n from public.ctl_dispute_contested_unadjudicated() where entity_id = did::text;
  if n <> 1 then raise exception 'FIX FAILED: contested-unadjudicated did not fire (n=%)', n; end if;
  update public.disputes set resolution_pct = 90 where id = did;
  select count(*) into n from public.ctl_dispute_contested_unadjudicated() where entity_id = did::text;
  if n <> 0 then raise exception 'FIX FAILED: control still fires after a decision'; end if;

  -- (2b) A hold with hours to live gets a SHORT window, never one past the money.
  update public.payments set authorized_at = now() - interval '6 days' - interval '20 hours'
   where booking_id = bid;
  delete from public.disputes where id = did;
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, photos)
  values (bid, poster, 'short runway', 80, '{}') returning id into did;
  select settle_after into sa from public.disputes where id = did;
  if sa >= (select coalesce(authorized_at, created_at) + interval '7 days'
              from public.payments where booking_id = bid) then
    raise exception 'FIX FAILED: the reply window outlives the authorization (%)', sa;
  end if;
  if sa <= now() then raise exception 'FIX FAILED: the window was stamped in the past (%)', sa; end if;

  -- (4) The policy now covers both photo columns.
  select pg_get_expr(polqual, polrelid) into body
    from pg_policy where polname = 'completion_party_read';
  if position('response_photos' in body) = 0 then
    raise exception 'FIX FAILED: the read policy still ignores the rebuttal photos';
  end if;
  if position('d.photos' in body) = 0 then
    raise exception 'FIX FAILED: the read policy lost the accusation photos';
  end if;

  raise notice 'probe: clock re-anchored, window bounded, reversal rows inert, rebuttal readable';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
