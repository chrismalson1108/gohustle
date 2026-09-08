-- Two holes in respond_to_dispute, both found by driving it against production.
--
-- ── 1. A REFUND RECORD CAN BE "ACCEPTED", AND THAT CLOSES IT ────────────────
--
-- stripe-webhook's recordReversal files a bare row for a refund or chargeback:
-- booking_id, raised_by, reason, and NOTHING else. No proposed_pct, no clock. Its whole
-- job is to sit open and block earner-claim-payment while a reversal is unexplained, and
-- to put the case in front of a human on /disputes.
--
-- dispute_set_defaults gives it a respondent_id — deliberately, because that column names
-- the counterparty on every row — but respond_to_dispute never checked whether the row is
-- an ADJUSTMENT. So the earner can answer it, and then branch 2 of dispute_settlement_pct
--
--     if d.response_stance = 'accept' then return coalesce(d.proposed_pct, 100); end if;
--
-- reads a NULL proposed_pct and returns ONE HUNDRED. Measured live 2026-09-08: filed the
-- exact recordReversal shape, called respond_to_dispute(accept) as the earner, and
-- dispute_due_pct went from NULL to 100. settle-disputes then stamps pct_paid and
-- resolved_at and closes it — so the earner clears their own blocker on a booking whose
-- money Stripe has already taken back, and earner-claim-payment will settle it.
--
-- 20260909040000 guarded branch 3 against precisely this ("giving it a window armed
-- branch 3, which would settle and auto-close the row whose whole job is to block
-- earner-claim-payment"). Branch 2 never got the same guard. Both halves are closed here:
-- the RPC refuses the row, and the branch refuses to price it.
--
-- ── 2. SILENCE DOES NOT STAND — IT CAN BE RETRACTED FOR AN HOUR ─────────────
--
-- CLAUDE.md: "the earner said nothing past settle_after -> proposed_pct (SILENCE STANDS)".
-- It does not. settle-disputes runs on the hourly sweep at :05, so between settle_after
-- passing and the sweep running there is a window of up to 59 minutes in which the
-- dispute is already DUE at proposed_pct and nothing has captured it yet. Measured live:
-- window closed with due_pct = 60, the earner contested inside the gap, and due_pct became
-- NULL — the settlement that was due simply stopped being due.
--
-- That is not a tie the earner happens to win, it is a strategy. Wait for the window to
-- close, then contest: the 60% the poster proposed evaporates, the case reopens, and
-- branch 4 pays 100% five days later if nobody adjudicates. The poster proposed a
-- reduction, won it on the clock, and had it taken back after time was up.
--
-- The window is the window. A reply after it is refused, and the message says when it
-- closed so the person is not left guessing.

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
  -- Only the accused, and only while it is still open. Not the raiser: they had
  -- their say when they proposed.
  if d.respondent_id is distinct from auth.uid() then
    raise exception 'not your dispute' using errcode = 'insufficient_privilege';
  end if;

  -- NOT EVERY disputes ROW IS AN ADJUSTMENT. A refund or chargeback record carries no
  -- proposed_pct; there is no percentage to accept and nothing to contest. Answering it
  -- used to make branch 2 price it at 100 and close it.
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
    raise exception 'the reply window closed on % — this will be paid at %%%',
      to_char(d.settle_after at time zone 'UTC', 'Mon DD HH24:MI') || ' UTC',
      coalesce(d.proposed_pct, 100)
      using errcode = 'check_violation';
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

-- ── Branch 2 must not price a row that carries no proposal ─────────────────
-- Defence in depth: even if something other than respond_to_dispute ever writes
-- response_stance, a row with no proposed_pct has no outcome to settle. This mirrors the
-- guard branch 3 already carries (`settle_after is not null`).
create or replace function public.dispute_settlement_pct(d public.disputes)
returns integer
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  auth_at timestamptz;
begin
  if d.pct_paid is not null then return null; end if;

  -- 1. An operator decided. Highest precedence — a human looked at both sides.
  if d.resolution_pct is not null then return d.resolution_pct; end if;

  -- NOT AN ADJUSTMENT -> NO OUTCOME. A refund/chargeback record has no proposed_pct;
  -- every branch below would invent one out of coalesce(..., 100). Branch 3 already
  -- refused these via `settle_after is not null`; branch 2 did not, and an earner who
  -- "accepted" a refund record got 100 and closed the row that was blocking their own
  -- claim. Nothing past this point runs on a record row.
  if d.proposed_pct is null then return null; end if;

  -- 2. The earner accepted the proposal.
  if d.response_stance = 'accept' then return d.proposed_pct; end if;

  -- 3. The earner said nothing and the window has closed. Silence stands — and
  --    respond_to_dispute now refuses a late reply, so it genuinely does.
  if d.responded_at is null and d.settle_after is not null and now() >= d.settle_after then
    return d.proposed_pct;
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
$function$;

-- ── Probe: both holes closed, and nothing else moved ───────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; d_rec uuid; d_adj uuid;
  pct int; ok boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 110000', 'Handyman', 200, 'flat', 'Monroe, LA', 'probe', poster, 'open')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 20000, 1400, 18600, 'authorized', 'pi_probe_110000', now(), now());

  -- ── 1. A refund record cannot be answered, and cannot be priced ─────────
  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'Stripe refund on charge ch_probe110 (usd 50.00 refunded)')
  returning id into d_rec;

  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  begin
    perform public.respond_to_dispute(d_rec, 'accept', null, '{}');
    raise exception 'FIX FAILED: a refund record was answerable';
  exception
    when check_violation then null;   -- expected
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Even forced past the RPC, the branch must refuse to price it.
  update public.disputes set response_stance = 'accept', responded_at = now() where id = d_rec;
  select public.dispute_due_pct(d_rec) into pct;
  if pct is not null then
    raise exception 'FIX FAILED: branch 2 priced a record row at %', pct;
  end if;

  -- ── 2. A late reply is refused, and silence still settles ──────────────
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe adjustment', 60) returning id into d_adj;
  update public.disputes set settle_after = now() - interval '5 minutes' where id = d_adj;

  select public.dispute_due_pct(d_adj) into pct;
  if pct <> 60 then raise exception 'FIX FAILED: silence no longer settles at 60 (got %)', pct; end if;

  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  begin
    perform public.respond_to_dispute(d_adj, 'contest', 'late', '{}');
    raise exception 'FIX FAILED: a contest after the window still landed';
  exception
    when check_violation then null;   -- expected
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select public.dispute_due_pct(d_adj) into pct;
  if pct <> 60 then
    raise exception 'FIX FAILED: the due settlement was retracted anyway (got %)', pct;
  end if;

  -- ── 3. An IN-WINDOW reply still works, and accept still expedites ──────
  update public.disputes set settle_after = now() + interval '40 hours' where id = d_adj;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',earner::text)::text, true);
  select public.respond_to_dispute(d_adj, 'accept', 'fine', '{}') into ok;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if not ok then raise exception 'FIX FAILED: an in-window reply was refused'; end if;
  if (select settle_after from public.disputes where id = d_adj)
     > (select responded_at + interval '1 minute' from public.disputes where id = d_adj) then
    raise exception 'FIX FAILED: accepting no longer expedites (20260909070000 regressed)';
  end if;
  select public.dispute_due_pct(d_adj) into pct;
  if pct <> 60 then raise exception 'FIX FAILED: an accepted adjustment is due at % not 60', pct; end if;

  raise notice 'probe: records are unanswerable and unpriceable; a late reply cannot retract a due settlement; in-window replies are untouched';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
