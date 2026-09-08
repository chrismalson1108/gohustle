-- ─────────────────────────────────────────────────────────────────────────────
-- Don't tell somebody they have 48 hours to answer a decision that is already made.
--
-- 20260909040000 gated the respondent's notice on `proposed_pct is not null`, which
-- keeps a refund/chargeback row from manufacturing an accusation. There is a second
-- row shape with the same problem in the other direction: stripe-capture-payment's
-- NO_ROOM_TO_HOLD branch now files a PRE-SETTLED adjustment — the poster asked to pay
-- less, the card hold was hours from expiring, so the platform captured in full and
-- recorded why. That row carries a real proposed_pct, so the notice fired and told the
-- earner they had until a deadline to reply to a reduction that was never applied and
-- cannot be.
--
-- `pct_paid is not null` means the money has already moved. There is never a window to
-- announce on such a row.
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- A reversal row accuses nobody (see 20260909040000), and a row that is already
  -- settled has no window to offer. Both would be a clock over our signature on a
  -- decision the reader cannot change.
  if new.proposed_pct is null or new.pct_paid is not null then return new; end if;

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

do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; d1 uuid; d2 uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 050000', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_050000', now(), now());

  -- Pre-settled (the NO_ROOM_TO_HOLD shape): no notice.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct, pct_paid,
                               settled_at, resolved_at, status)
  values (bid, poster, 'no runway', 75, 100, now(), now(), 'rejected') returning id into d1;
  if exists (select 1 from public.notifications where data->>'dispute_id' = d1::text) then
    raise exception 'FIX FAILED: a pre-settled adjustment announced a reply window';
  end if;

  -- A live proposal still gets its notice, with the real deadline in it.
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'live proposal', 75) returning id into d2;
  if not exists (select 1 from public.notifications
                  where data->>'dispute_id' = d2::text and body like '%75%' and body like '%UTC%') then
    raise exception 'FIX FAILED: a live proposal lost its notice or its deadline';
  end if;

  raise notice 'probe: settled rows are silent, live proposals still name their deadline';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
