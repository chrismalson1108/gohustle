-- "this will be paid at %60".
--
-- 20260909110000 (an hour old) added the late-reply refusal and built its message with
--
--     raise exception 'the reply window closed on % — this will be paid at %%%', d, pct
--
-- `%%%` does not mean "placeholder then literal percent". Postgres scans left to right,
-- takes `%%` as the escaped literal and the remaining `%` as the placeholder, so the
-- number lands AFTER the sign: "paid at %60". Verified against production immediately
-- after the push.
--
-- It is one character of formatting on a sentence an earner reads at the exact moment
-- they are told they have missed their window and will be paid less than they hoped —
-- which is not the moment for the platform to look like it cannot count. Built by
-- concatenation instead, where the order is not up to a format parser.
--
-- Nothing else in the function changes. The guards from 20260909110000 are reproduced
-- verbatim and re-asserted by the probe.

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
  -- proposed_pct; there is no percentage to accept and nothing to contest. Answering one
  -- used to make branch 2 price it at 100 and close the row that blocks
  -- earner-claim-payment. See 20260909110000.
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

  -- THE WINDOW IS THE WINDOW. settle-disputes runs hourly, so a row whose settle_after
  -- has passed is already due at proposed_pct even though no capture has happened yet;
  -- allowing a reply here let the earner retract a settlement they had lost on the clock.
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
                   || 'but if we have not decided before the card hold runs out, the full amount is '
                   || 'charged and paid to them.' end,
         j.id,
         jsonb_build_object('dispute_id', d.id, 'booking_id', d.booking_id)
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = d.booking_id;

  return true;
end;
$function$;

do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; d_adj uuid; d_rec uuid; got text; pct int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 120000', 'Handyman', 200, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 20000, 1400, 18600, 'authorized', 'pi_probe_120000', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe', 60) returning id into d_adj;
  update public.disputes set settle_after = now() - interval '5 minutes' where id = d_adj;

  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  begin
    perform public.respond_to_dispute(d_adj, 'contest', 'late', '{}');
    raise exception 'FIX FAILED: a late reply still landed';
  exception when check_violation then
    got := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  if got like '%!%60%' then
    raise exception 'FIX FAILED: the percent sign is still on the wrong side — %', got;
  end if;
  if got not like '%60!%%' escape '!' then
    raise exception 'FIX FAILED: the message no longer names the percentage — %', got;
  end if;

  -- And 110000's two guards are still in force.
  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'Stripe refund on charge ch_probe120 (usd 5.00 refunded)') returning id into d_rec;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  begin
    perform public.respond_to_dispute(d_rec, 'accept', null, '{}');
    raise exception 'FIX FAILED: a refund record became answerable again';
  exception when check_violation then null;
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select public.dispute_due_pct(d_adj) into pct;
  if pct <> 60 then raise exception 'FIX FAILED: silence no longer stands at 60 (got %)', pct; end if;

  raise notice 'probe: the message reads "paid at 60%%", and 110000''s guards still hold';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
