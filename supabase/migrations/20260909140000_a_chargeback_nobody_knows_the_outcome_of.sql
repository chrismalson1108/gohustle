-- Nothing recorded whether a chargeback was WON or LOST, so the two reversal controls
-- contradicted each other for the whole 30-75 day life of every card dispute.
--
-- `ctl_external_reversal_not_ledgered` fires 24h after `charge.dispute.created` with no
-- reference to the dispute's Stripe status, and prints an unconditional remedy: press
-- "Record chargeback". `reconcile-stripe` deliberately counts only `d.status = 'lost'`
-- ("an open one has been withdrawn pending the outcome and our ledger is correctly still
-- 0"), and any mismatch there is CRITICAL. So while a dispute was open the operator could
-- not satisfy both:
--
--   leave refunded_cents at 0  -> the HIGH finding stays open, for weeks
--   follow the printed remedy  -> a CRITICAL refund_mismatch opens instead
--
-- and if the platform then WON, `refunded_cents` permanently claimed money had been
-- returned on a charge nobody reversed. `record_refund` is add-only, no console writer
-- touches the column, and `admin-payment-action` has no reversing op — so there was no
-- way back. Downstream, the poster's receipt reads "Refunded to you -$N" for money they
-- never got (shared/ledger.js), and `vest_bonuses` voids the referrer's bonus on that
-- booking with no path to re-mint it.
--
-- There is no `charge.dispute.closed` handler anywhere in the repo; RUNBOOK_MONEY.md
-- records it as deliberately unsubscribed. That was the root: the state existed at Stripe
-- and nothing here could see it.
--
-- STORE THE OUTCOME INSTEAD OF INFERRING IT. `disputes.external_status` is written only by
-- stripe-webhook, from Stripe's own dispute status, and the control's chargeback arm now
-- waits for it.

alter table public.disputes
  add column if not exists external_status text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'disputes_external_status_chk') then
    alter table public.disputes
      add constraint disputes_external_status_chk
      check (external_status is null or external_status in ('open', 'won', 'lost'));
  end if;
end $$;

comment on column public.disputes.external_status is
  'For a reversal RECORD only (a row with no proposed_pct): the Stripe card dispute''s own '
  'outcome. null = not a card dispute, or created before 20260909140000. open = raised, '
  'undecided. won = the platform kept the money, so refunded_cents must stay 0. lost = the '
  'money is gone for good and belongs in refunded_cents. Written ONLY by stripe-webhook '
  'from charge.dispute.created / charge.dispute.closed; pinned against everybody else by '
  'guard_disputes_write. Deliberately NOT granted to authenticated — no client reads it, '
  'and the disputes grant is by column name.';

-- The column is NOT added to any client grant. Table-wide SELECT is revoked (20260909030000)
-- and columns are granted by name, so a new column is private by default — which is the
-- posture we want and the reason that migration was written that way.

-- ── Pin it: only the webhook may write it ────────────────────────────────────────────
--
-- guard_disputes_write already pins every settlement, adjudication and provenance column
-- and exempts service_role. The body below is the LIVE one read back from pg_proc with a
-- single line added — not a re-derivation. Copy-forward drift in this function is how the
-- support guard lost its exemption twice, so it is copied, not rewritten.
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
  -- NEW (20260909140000): Stripe's own verdict on a card dispute. A party who could write
  -- this could tell the control a LOST chargeback was won, which is the single value that
  -- stops the money being ledgered at all.
  new.external_status:= old.external_status;

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

-- ── The control waits for the outcome ────────────────────────────────────────────────
create or replace function public.ctl_external_reversal_not_ledgered()
returns table(entity_id text, detail jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
with reversal as (
  select distinct on (dd.booking_id)
         dd.booking_id,
         dd.id,
         dd.reason,
         dd.created_at,
         dd.resolved_at,
         dd.external_status,
         (dd.reason ilike 'Stripe chargeback%') as is_chargeback,
         -- TWO templates, TWO shapes. The refund one ends '… usd 40.00 refunded)';
         -- the chargeback one ends '… (fraudulent, usd 100.00)'.
         round(coalesce(
           substring(dd.reason from '([0-9]+\.[0-9]{2}) refunded\)'),
           substring(dd.reason from 'usd ([0-9]+\.[0-9]{2})\)$')
         )::numeric * 100)::bigint
           as reversal_cents
    from public.disputes dd
   -- Two writers reach this column. The prefix is the cheap scan filter; the anchored
   -- pattern is what separates stripe-webhook's template from a poster's typed note.
   where (
           dd.reason ilike 'Stripe refund on charge%'
       and dd.reason ~ '^Stripe refund on charge (ch|py)_[A-Za-z0-9]{8,} \([a-z]{3} [0-9]+\.[0-9]{2} refunded\)$'
         )
      or (
           dd.reason ilike 'Stripe chargeback%'
       and dd.reason ~ '^Stripe chargeback (dp|du)_[A-Za-z0-9]{8,} \([^()]*, [a-z]{3} [0-9]+\.[0-9]{2}\)$'
         )
   order by dd.booking_id, dd.created_at desc
),
tip_rev as (
  select t.booking_id,
         sum(coalesce(t.reversed_cents, 0))::bigint as reversed_cents
    from public.tip_ledger t
   where coalesce(t.reversed_cents, 0) > 0
     and t.reversed_at is not null
   group by t.booking_id
)
select p.id::text,
  jsonb_build_object(
    'booking_id', p.booking_id,
    'payment_status', p.status,
    'payment_intent_id', p.payment_intent_id,
    'authorized_cents', p.amount_cents,
    'captured_total_cents', coalesce(p.earner_amount_cents, 0) + coalesce(p.fee_cents, 0),
    'reversal_cents', d.reversal_cents,
    'refunded_cents', coalesce(p.refunded_cents, 0),
    'unledgered_cents',
      case when d.reversal_cents is null then null
           else d.reversal_cents - coalesce(p.refunded_cents, 0) end,
    'refund_source', p.refund_source,
    'earnings_credited', coalesce(p.earnings_credited, false),
    'earner_id', b.earner_id,
    'dispute_id', d.id,
    'dispute_reason', d.reason,
    'dispute_created_at', d.created_at,
    'dispute_resolved_at', d.resolved_at,
    'external_status', d.external_status,
    'tip_reversed_cents', coalesce(tr.reversed_cents, 0),
    'basil_note', 'partial-capture releases no longer appear in amount_refunded '
                  '(Stripe 2025-03-31.basil), so this figure is compared raw. Correct '
                  'only while the API version pin is 2026-07-29.dahlia.',
    'remedy',
      case
        -- A chargeback whose outcome never arrived. This is the backstop for
        -- charge.dispute.closed not being subscribed, or a delivery being dropped:
        -- without it, "wait for the outcome" would be indistinguishable from silence.
        when d.is_chargeback and coalesce(d.external_status, 'open') = 'open'
        then 'THE OUTCOME OF THIS CHARGEBACK NEVER ARRIVED. It has been open for more than '
             '75 days, which is past the longest normal card-network lifecycle, so either '
             'charge.dispute.closed is not subscribed on the Stripe endpoint (check '
             'ctl_stripe_webhook_config) or a delivery was dropped. Look the dispute up in '
             'Stripe by the id in dispute_reason and act on the REAL outcome: if we lost, '
             'use admin console -> booking -> Record chargeback; if we won, resolve this '
             'row and leave refunded_cents at 0. Do NOT record a loss you have not '
             'confirmed — refunded_cents is add-only and nothing in this codebase can take '
             'it back.'
        when not (
               coalesce(tr.reversed_cents, -1) = coalesce(d.reversal_cents, -2)
           and coalesce(p.refunded_cents, 0) = 0
             )
        then 'The money ALREADY moved at Stripe — this is a bookkeeping gap, not a refund '
             'to issue. Use admin console -> booking -> Record chargeback, which writes '
             'refunded_cents WITHOUT calling Stripe. Do NOT press Refund: that creates a '
             'SECOND real refund (reverse_transfer:true), and because our refunded_cents is '
             '0 here both its cap and its idempotency key are computed from a ledger that '
             'does not know about the Stripe-side refund, so nothing stops it. Note Record '
             'chargeback does not debit the earner (20260813160000 — the platform absorbs a '
             'destination-charge reversal); reconcile the earner separately if the money was '
             'genuinely recovered from them.'
        else 'LIKELY A REVERSED TIP, NOT A GIG REFUND. This booking has $' ||
             to_char(tr.reversed_cents / 100.0, 'FM999999990.00') ||
             ' of TIP already reversed in tip_ledger — exactly the figure in this dispute '
             'row — and the gig payment shows no refund at all. Until 2026-09-06 '
             'stripe-webhook filed a disputes row for a reversed tip against the gig''s '
             'booking in this same template. CHECK THE STRIPE OBJECT ID IN dispute_reason: '
             'if it belongs to the TIP''s PaymentIntent, the money is ALREADY ledgered in '
             'tip_ledger.reversed_cents (which ctl_earnings_total_drift subtracts) and there '
             'is nothing to record — resolve the dispute row and leave the payment alone. '
             'Do NOT press Record chargeback here: it writes refunded_cents onto a gig '
             'charge nobody refunded, which makes the poster''s receipt read "Refunded to '
             'you" on work they paid for, and makes vest_bonuses void any referral bonus '
             'sourced from this booking. Only if the id belongs to the GIG''s PaymentIntent '
             'does the standard remedy apply.'
      end
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join reversal d on d.booking_id = p.booking_id
left join tip_rev tr on tr.booking_id = p.booking_id
where p.status = 'captured'
  and d.created_at < now() - interval '24 hours'
  -- ── A CHARGEBACK IS ONLY ACTIONABLE ONCE ITS OUTCOME IS KNOWN ──────────────────────
  --
  -- Won: the platform kept the money and refunded_cents is CORRECTLY 0. There is nothing
  -- to record, and telling an operator to record it is how the ledger got corrupted.
  -- Open: the money is provisionally withdrawn and reconcile-stripe deliberately expects
  -- our ledger to still read 0 — so firing here would demand the exact write that opens a
  -- CRITICAL finding next door. charge.dispute.created already emails the on-call, and the
  -- disputes row already blocks earner-claim-payment, so an open chargeback is not silent.
  -- Past 75 days, fire anyway: at that point "still open" means the outcome event never
  -- arrived, and a control that stays quiet on missing data is the 2026-07-10 failure.
  and (
        not d.is_chargeback
        or d.external_status = 'lost'
        or (coalesce(d.external_status, 'open') = 'open'
            and d.created_at < now() - interval '75 days')
      )
  and (
        (d.reversal_cents is null and coalesce(p.refunded_cents, 0) = 0)
        or
        (d.reversal_cents is not null
         and d.reversal_cents > coalesce(p.refunded_cents, 0))
      )
$function$;

-- ── Probe: broken vs fixed on the same staged row, rolled back ───────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid;
  n_open int; n_won int; n_lost int; n_stale int; n_refund int;
  rem text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 140000', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'verified', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at, refunded_cents)
  values (bid, 10000, 700, 9300, 'captured', 'pi_probe_140000', now(), now(), 0);

  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'Stripe chargeback du_probe140000abcd (fraudulent, usd 100.00)')
  returning id into did;
  update public.disputes set created_at = now() - interval '3 days' where id = did;

  -- 1. OPEN: must be silent. This is the state the old control fired on, telling the
  --    operator to write refunded_cents while reconcile-stripe expected 0.
  select count(*) into n_open from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if n_open <> 0 then
    raise exception 'FIX FAILED: an OPEN chargeback still fires (%). That is the contradiction.', n_open;
  end if;

  -- 2. LOST: must fire, with the standard remedy and a real figure.
  update public.disputes set external_status = 'lost' where id = did;
  select count(*) into n_lost from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if n_lost <> 1 then raise exception 'FIX FAILED: a LOST chargeback does not fire (%)', n_lost; end if;
  select detail->>'remedy' into rem from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if rem not like 'The money ALREADY moved%' then
    raise exception 'FIX FAILED: a LOST chargeback got the wrong remedy — %', left(rem, 80);
  end if;
  if (select detail->>'reversal_cents' from public.ctl_external_reversal_not_ledgered()
       where entity_id in (select id::text from public.payments where booking_id = bid)) <> '10000' then
    raise exception 'FIX FAILED: 20260909130000''s figure regressed';
  end if;

  -- 3. WON: must be silent, and stay silent. refunded_cents is correctly 0.
  update public.disputes set external_status = 'won' where id = did;
  select count(*) into n_won from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if n_won <> 0 then raise exception 'FIX FAILED: a WON chargeback still fires (%)', n_won; end if;

  -- 4. OPEN PAST 75 DAYS: the backstop. Missing data must not read as "nothing to do".
  update public.disputes set external_status = null, created_at = now() - interval '80 days' where id = did;
  select count(*) into n_stale from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if n_stale <> 1 then raise exception 'FIX FAILED: a chargeback open 80 days is invisible (%)', n_stale; end if;
  select detail->>'remedy' into rem from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if rem not like 'THE OUTCOME OF THIS CHARGEBACK NEVER ARRIVED%' then
    raise exception 'FIX FAILED: the backstop remedy is wrong — %', left(rem, 80);
  end if;

  -- 5. A REFUND row is untouched by any of this — it has no external_status and never will.
  update public.disputes set reason = 'Stripe refund on charge ch_probe140000abcd (usd 100.00 refunded)',
                             external_status = null, created_at = now() - interval '3 days' where id = did;
  select count(*) into n_refund from public.ctl_external_reversal_not_ledgered() where entity_id in
    (select id::text from public.payments where booking_id = bid);
  if n_refund <> 1 then raise exception 'FIX FAILED: a refund row stopped firing (%)', n_refund; end if;

  -- 6. The guard pins the new column against a party.
  update public.disputes set external_status = 'lost', reason =
    'Stripe chargeback du_probe140000abcd (fraudulent, usd 100.00)' where id = did;
  perform set_config('request.jwt.claims',
                     json_build_object('role','authenticated','sub',poster::text)::text, true);
  update public.disputes set external_status = 'won' where id = did;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if (select external_status from public.disputes where id = did) <> 'lost' then
    raise exception 'FIX FAILED: a party can overwrite Stripe''s verdict';
  end if;

  raise notice 'probe: open=silent, lost=fires, won=silent, 80d-open=fires with the backstop, refund unchanged, guard pins';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
