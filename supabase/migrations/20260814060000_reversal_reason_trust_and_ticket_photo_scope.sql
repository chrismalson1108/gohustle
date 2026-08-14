-- ─────────────────────────────────────────────────────────────────────────────
-- Two records that are trusted for looking like they came from somewhere they did not.
--
--  1. ctl_external_reversal_not_ledgered decides a Stripe reversal happened by reading
--     disputes.reason — a column a POSTER writes free text into.
--  2. support_photos_read_ticket decides an attachment is readable by reading the
--     object's PATH — which an aborted upload writes just as faithfully as a sent one.
--
-- Both are the same shape: authorising on a string whose author is not who the reader
-- assumes. Neither fix widens anything; both are strictly narrower than what shipped.
--
-- ═══ 1. disputes.reason is not a webhook-only column ═════════════════════════
--
-- 20260814000000 restored the control's matcher to `reason ilike 'Stripe chargeback%'`
-- / `'Stripe refund on charge%'`, which is right about where the webhook's rows come
-- from and wrong about who ELSE can write that column. stripe-capture-payment files a
-- disputes row on every partial capture carrying the poster's own "report a problem"
-- note, verbatim:
--
--     reason: String(disputeReason).trim().slice(0, 500)     (index.ts:473)
--
-- So a poster who types "Stripe chargeback incoming — half the work was never done"
-- hands the control a row it reads as an external reversal. It carries no cents figure,
-- so it takes the `reversal_cents is null and refunded_cents = 0` branch and opens a
-- HIGH money finding — and that finding can NEVER auto-resolve, because the only thing
-- that would clear it is recording a reversal that never happened. control_findings is
-- unique on (control_key, entity_id) while open, so it sits on the board forever, the
-- hourly sweep pages a human for it, and the remedy sends an operator to a booking
-- where nothing is wrong. A control that cannot be trusted is worse than no control:
-- the next real one is read as more of the same.
--
-- The fix matches the webhook's two literal templates end to end (stripe-webhook
-- index.ts:507 and :534), including the Stripe object id:
--
--     Stripe refund on charge ch_… (usd 35.00 refunded)
--     Stripe chargeback dp_… (fraudulent, usd 60.00)
--
-- The ilike prefixes STAY in front of the regexes. They are the cheap pre-filter over
-- the whole disputes table (there is no index on reason, and the CTE is scanned once
-- before anything joins to it), and they are the half
-- __tests__/reversalReasonParity.test.js reads to prove the control can still see what
-- stripe-webhook writes. The anchored regexes are the authenticity half, and the probe
-- at the bottom of this file is what asserts them.
--
-- Deliberately NOT also keyed on `pct_paid is null` — true of every webhook row today
-- and a tempting structural discriminator, but nothing tests that assumption, so the
-- day something backfills that column the control goes blind in silence. The reason
-- templates have a parity test watching them; that is the half worth depending on.
--
-- Everything else about the control is carried forward verbatim from 20260814050000 —
-- the distinct-on, the Basil note, and the remedy that tells the operator NOT to press
-- Refund.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_external_reversal_not_ledgered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $function$
with reversal as (
  select distinct on (dd.booking_id)
         dd.booking_id,
         dd.id,
         dd.reason,
         dd.created_at,
         dd.resolved_at,
         round(substring(dd.reason from '([0-9]+\.[0-9]{2}) refunded\)')::numeric * 100)::bigint
           as reversal_cents
    from public.disputes dd
   -- Two writers reach this column. The prefix is the cheap scan filter; the anchored
   -- pattern is what separates stripe-webhook's template from a poster's typed note,
   -- which lands here verbatim from the "report a problem" flow. A Stripe object id and
   -- a fixed shape end to end is not something free text produces by accident.
   where (
           dd.reason ilike 'Stripe refund on charge%'
       and dd.reason ~ '^Stripe refund on charge (ch|py)_[A-Za-z0-9]{8,} \([a-z]{3} [0-9]+\.[0-9]{2} refunded\)$'
         )
      or (
           dd.reason ilike 'Stripe chargeback%'
       and dd.reason ~ '^Stripe chargeback (dp|du)_[A-Za-z0-9]{8,} \([^()]*, [a-z]{3} [0-9]+\.[0-9]{2}\)$'
         )
   order by dd.booking_id, dd.created_at desc
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
    'basil_note', 'partial-capture releases no longer appear in amount_refunded '
                  '(Stripe 2025-03-31.basil), so this figure is compared raw. Correct '
                  'only while the API version pin is 2026-07-29.dahlia.',
    'remedy', 'The money ALREADY moved at Stripe — this is a bookkeeping gap, not a refund '
              'to issue. Use admin console -> booking -> Record chargeback, which writes '
              'refunded_cents WITHOUT calling Stripe. Do NOT press Refund: that creates a '
              'SECOND real refund (reverse_transfer:true), and because our refunded_cents is '
              '0 here both its cap and its idempotency key are computed from a ledger that '
              'does not know about the Stripe-side refund, so nothing stops it. Note Record '
              'chargeback does not debit the earner (20260813160000 — the platform absorbs a '
              'destination-charge reversal); reconcile the earner separately if the money was '
              'genuinely recovered from them.'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
join reversal d on d.booking_id = p.booking_id
where p.status = 'captured'
  and d.created_at < now() - interval '24 hours'
  and (
        (d.reversal_cents is null and coalesce(p.refunded_cents, 0) = 0)
        or
        (d.reversal_cents is not null
         and d.reversal_cents > coalesce(p.refunded_cents, 0))
      )
$function$;

revoke execute on function public.ctl_external_reversal_not_ledgered() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- ═══ 2. An orphaned upload is not an attachment ══════════════════════════════
--
-- 20260814020000 unblocked agent attachments by authorising on the object path's first
-- segment: `ticket-<id>` must name a ticket the caller owns. Nothing checks the object
-- is one the thread actually CARRIES, and the console produces objects that no thread
-- ever carried:
--
--   admin/app/(console)/support/actions.ts:60-73 uploads the batch in a loop and
--   returns on the FIRST file that is over 8MB or is not an image — after the earlier
--   files in that batch have already landed in storage. The message insert, the only
--   thing that records which paths were sent, never runs. Same for an upload error
--   partway through.
--
-- So `ticket-<id>/` accumulates objects the user was never sent, and on storage.objects
-- ONE `for select` policy governs both downloading an object and LISTING the prefix —
-- so a path-shaped grant hands the ticket owner every orphan plus the index to find
-- them. An agent who attached the wrong customer's screenshot, tripped the size check
-- on the next file and re-sent without it has still published it.
--
-- Readability now follows from the reference: some message on that ticket must name
-- this exact object in images[]. Narrower than what 20260814020000 set out to grant —
-- the only objects it takes away are the ones no thread ever carried — and the
-- ticket-ownership test stays in front of it, so a user still cannot name another
-- user's owner-scoped object in their own thread and read it that way.
--
-- images[] holds BARE OBJECT PATHS, not URLs: the console pushes the same `path` string
-- it uploaded (actions.ts:66-70) and the app stores what uploadPrivateImage returns,
-- which is the path (src/lib/uploadImage.js). So the predicate is equality against
-- storage.objects.name, not a suffix match.
--
-- ⚠️ `objects.name` MUST be qualified. public.support_tickets has its own `name` column
-- (the name typed on the support form), and Postgres resolves an unqualified column to
-- the innermost scope that has one — it only raises ambiguity WITHIN a level. So the
-- `name` inside `exists (select 1 from public.support_tickets t …)` binds to t.name,
-- not to the object being authorised. That is what 20260814020000 shipped, which is why
-- the agent attachment it was written to unblock still renders broken — and it is the
-- one thing about that policy this migration LOOSENS rather than tightens. Its probe
-- read a local variable rather than a column, so the shadow was invisible to it; the
-- probe below evaluates both bindings and reports which one production has.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists support_photos_read_ticket on storage.objects;
create policy support_photos_read_ticket on storage.objects
  for select to authenticated
  using (
    bucket_id = 'support-photos'
    and (storage.foldername(objects.name))[1] like 'ticket-%'
    -- The thread named in the path must be one this user owns. Reads the ticket's
    -- owner rather than trusting the path, so guessing `ticket-999/…` still fails.
    and exists (
      select 1
        from public.support_tickets t
       where t.id = nullif(
               substring((storage.foldername(objects.name))[1] from '^ticket-([0-9]+)$'), ''
             )::bigint
         and t.user_id = auth.uid()
    )
    -- …and the object must be one the thread actually carries. A second EXISTS on
    -- purpose: support_ticket_messages has no `name` column of its own, so this scope
    -- cannot shadow the object being authorised the way the one above can.
    and exists (
      select 1
        from public.support_ticket_messages m
       where m.ticket_id = nullif(
               substring((storage.foldername(objects.name))[1] from '^ticket-([0-9]+)$'), ''
             )::bigint
         and objects.name = any (m.images)
    )
  );

-- ── Prove the control no longer trusts a poster's typing ────────────────────
do $$
declare
  bid uuid; pid uuid; jid uuid; uid uuid;
  n_shipped int; n_typed int; n_chargeback int; n_refund int; n_ledgered int;
  -- What "report a problem" lets a poster write straight into disputes.reason.
  typed_reason text := 'Stripe chargeback incoming — half the work was never done';
  -- stripe-webhook/index.ts:507 and :534, verbatim shapes.
  real_chargeback text := 'Stripe chargeback dp_1AbCdEfGhIjKlMnO (fraudulent, usd 60.00)';
  real_refund     text := 'Stripe refund on charge ch_3AbCdEfGhIjKlMnO (usd 35.00 refunded)';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'reason trust probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status)
  values (jid, uid, 'verified') returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at)
  values (bid, 'pi_reason_trust_probe', 10000, 420, 5580, 0, 'captured', now()) returning id into pid;

  -- Backdated past the control's 24h grace, or nothing about this row is tested.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, typed_reason, now() - interval '48 hours');

  -- The shipped matcher selects it — that is the finding.
  select count(*) into n_shipped
    from public.disputes dd
   where dd.booking_id = bid
     and (dd.reason ilike 'Stripe refund on charge%' or dd.reason ilike 'Stripe chargeback%');
  if n_shipped <> 1 then
    raise exception 'probe is not discriminating: the shipped matcher ignored the typed reason (got %)', n_shipped;
  end if;

  select count(*) into n_typed
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_typed <> 0 then
    raise exception 'FIX FAILED: poster-typed text still manufactures a money finding (% rows)', n_typed;
  end if;
  raise notice 'discriminates: the shipped matcher selected the typed reason, the fixed control returns 0';

  -- Same booking, same payment, same age — only the reason differs. So this proves the
  -- detector is otherwise fully armed on the row above, and the reason is what stopped it.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, real_chargeback, now() - interval '36 hours');
  select count(*) into n_chargeback
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_chargeback <> 1 then
    raise exception 'CHARGEBACK ARM BROKEN: a real webhook chargeback on the same row gave % findings', n_chargeback;
  end if;
  raise notice 'chargeback arm intact on the identical row the typed reason could not trigger';

  -- Newest-row-wins, so this replaces the chargeback above and brings a cents figure.
  insert into public.disputes (booking_id, raised_by, reason, created_at)
  values (bid, uid, real_refund, now() - interval '30 hours');
  select count(*) into n_refund
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_refund <> 1 then
    raise exception 'REFUND ARM BROKEN: an unledgered $35 refund is invisible (got % rows)', n_refund;
  end if;

  update public.payments set refunded_cents = 3500 where id = pid;
  select count(*) into n_ledgered
    from public.ctl_external_reversal_not_ledgered() where entity_id = pid::text;
  if n_ledgered <> 0 then
    raise exception 'FALSE POSITIVE: fired on a correctly-ledgered refund';
  end if;
  raise notice 'refund arm intact and silent once the refund is ledgered';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'reversal-reason-trust probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;

-- ── Prove an orphan is refused and a sent attachment is not ─────────────────
do $$
declare
  owner_id uuid; other_id uuid; tid bigint;
  sent_path text; orphan_path text;
  old_intended boolean; old_as_shipped boolean;
  new_sent boolean; new_orphan boolean; new_other boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into owner_id from public.profiles where deleted_at is null limit 1;
  select id into other_id from public.profiles
   where deleted_at is null and id <> owner_id limit 1;
  if owner_id is null then raise exception 'no live profile to stage against'; end if;

  insert into public.support_tickets (user_id, email, subject, status)
  values (owner_id, 'probe@example.com', 'orphaned attachment probe', 'open')
  returning id into tid;

  sent_path   := 'ticket-' || tid || '/agent-' || gen_random_uuid() || '.jpg';
  -- What replyTicket leaves behind when a later file in the same batch trips the 8MB
  -- check: uploaded, and named by no message, because the insert never ran.
  orphan_path := 'ticket-' || tid || '/agent-' || gen_random_uuid() || '.jpg';

  insert into public.support_ticket_messages (ticket_id, author, body, images)
  values (tid, 'admin', 'here is the payout record', array[sent_path]);

  -- Become the ticket owner, so auth.uid() is the value the policy consults.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', owner_id::text)::text, true);

  -- `o` stands in for storage.objects: one relation supplying the `name` column, which
  -- is all the predicate reads off the row. (A migration cannot insert a storage object
  -- and re-authenticate; the predicate IS the thing under test.) Crucially `o` also
  -- reproduces the SHADOW — an unqualified `name` inside the support_tickets subquery
  -- has an inner column to bind to here exactly as it does in the policy.
  select
    exists (
      select 1 from public.support_tickets t
       where t.id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
         and t.user_id = auth.uid()),
    exists (
      select 1 from public.support_tickets t
       where t.id = nullif(substring((storage.foldername(name))[1] from '^ticket-([0-9]+)$'), '')::bigint
         and t.user_id = auth.uid())
    into old_intended, old_as_shipped
    from (select orphan_path as name) o;

  if not old_intended then
    raise exception 'probe is not discriminating: a path-shaped grant did not reach the orphan';
  end if;
  if old_as_shipped then
    raise notice 'the shipped predicate read the OBJECT name: every orphan under ticket-% was readable and listable', tid;
  else
    raise notice 'the shipped predicate read support_tickets.name (inner scope wins), so it granted nothing at all — qualifying objects.name is what makes an agent attachment render';
  end if;

  -- The fix, on the same two paths.
  select
    exists (
      select 1 from public.support_tickets t
       where t.id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
         and t.user_id = auth.uid())
    and exists (
      select 1 from public.support_ticket_messages m
       where m.ticket_id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
         and o.name = any (m.images))
    into new_sent
    from (select sent_path as name) o;

  select
    exists (
      select 1 from public.support_tickets t
       where t.id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
         and t.user_id = auth.uid())
    and exists (
      select 1 from public.support_ticket_messages m
       where m.ticket_id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
         and o.name = any (m.images))
    into new_orphan
    from (select orphan_path as name) o;

  if not new_sent then
    raise exception 'FIX FAILED: the ticket owner cannot read the attachment the agent sent (%)', sent_path;
  end if;
  if new_orphan then
    raise exception 'FIX FAILED: an orphaned upload is still readable (%)', orphan_path;
  end if;
  raise notice 'the sent attachment is readable; the orphan beside it is not';

  -- And ownership still gates it: a different account gets nothing from the same path.
  if other_id is not null then
    perform set_config('request.jwt.claims',
      json_build_object('role', 'authenticated', 'sub', other_id::text)::text, true);
    select
      exists (
        select 1 from public.support_tickets t
         where t.id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
           and t.user_id = auth.uid())
      and exists (
        select 1 from public.support_ticket_messages m
         where m.ticket_id = nullif(substring((storage.foldername(o.name))[1] from '^ticket-([0-9]+)$'), '')::bigint
           and o.name = any (m.images))
      into new_other
      from (select sent_path as name) o;
    if new_other then
      raise exception 'TOO BROAD: a non-owner can read %', sent_path;
    end if;
    raise notice 'a non-owner is still refused the same object';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'support-photos orphan probe passed; staged ticket and message rolled back';
  else
    raise;
  end if;
end $$;
