-- ─────────────────────────────────────────────────────────────────────────────
-- The tip idempotency key is released in OUR database and kept for 24 hours at STRIPE,
-- so the second legitimate tip of the same amount is answered by the first one's charge.
--
-- 20260814090000 made the reservation key deterministic — `resv_<booking>_<cents>` — and
-- handed the same string to Stripe as the idempotency key. Its header states the
-- intended property: the key "is released on confirm, so a second legitimate tip of the
-- same amount on the same booking (the count cap allows three) is not blocked by the
-- first". That is true of `tip_ledger_reservation_key_uidx`. It is NOT true of Stripe,
-- which retains an idempotency key for 24 hours and, for a repeat with identical
-- parameters, replays the ORIGINAL response instead of creating a second PaymentIntent.
--
-- So the second $10 tip on booking B, inside a day of the first:
--
--   1. reserve_tip_slot mints a NEW row and hands back the SAME key string, because the
--      first row's key was nulled at confirm.
--   2. paymentIntents.create under that key returns the FIRST PaymentIntent — already
--      succeeded — and no card is charged.
--   3. stripe-tip sees `status === 'succeeded'` and calls confirm_tip_charge(key, pi_1),
--      which looks up by payment_intent_id FIRST, finds the ALREADY CREDITED first row,
--      and returns true from its "credited already" branch.
--   4. The function answers {success:true, tipCents:1000}. Both clients then notify the
--      earner "You got a tip!" and patch tipAmount locally.
--
-- Nobody was charged, the earner was told they were paid, and the second reservation is
-- left PI-null holding booking/velocity headroom until it expires — after which
-- ctl_earner_credit_missing raises it as tip_reservation_unconfirmed and points the
-- operator at pi_1, "which succeeded", whose confirm resolves to row 1 again and can
-- never clear row 2.
--
-- The same key also replays a DECLINE for 24 hours after the reservation was released
-- for a retry, and a retry with a replaced card changes `payment_method`, which Stripe
-- rejects outright as idempotency_error.
--
-- ── THE FIX: the Stripe key is the reservation ROW, the slot key stays the slot key ──
-- Two keys with two different jobs, which the old design conflated into one string:
--
--   * `reservation_key` (unchanged) is the SLOT key. It must be deterministic per
--     (booking, cents), because `tip_ledger_reservation_key_uidx` is what collapses a
--     double tap: two concurrent taps race for one row and the loser reuses it. Making
--     this per-row would remove the unique conflict and let a double tap take two
--     reservations, i.e. charge the poster twice.
--   * the STRIPE idempotency key is now `resv_<reservation row id>`, returned by
--     reserve_tip_slot as `stripe_key`. It is per ROW, so it is stable exactly as long as
--     the reservation is — which is precisely the window in which a replay is wanted.
--
-- Every property 20260814090000 argued for survives, because they are all properties of
-- the ROW rather than of the string: a double tap reuses the live reservation and gets
-- the same stripe_key (one PaymentIntent); a retry after a timeout reuses it too
-- (exactly-once, not merely likely); and only a genuinely NEW reservation — after a
-- confirm, a release or an expiry — gets a key Stripe has never seen.
--
-- ctl_earner_credit_missing's derivation moves with it. `legacy_stripe_idempotency_key`
-- is emitted alongside for rows written before this migration, whose charge really did
-- go out under the old slot-key form; an operator looking a stranded PaymentIntent up in
-- Stripe has to be able to try both, and inventing one truth for both eras would send
-- them to the wrong charge.
--
-- Reachable today only by calling the function directly — both clients tip once, from the
-- verify sheet — so this is the latent half of the intended multi-tip design rather than
-- a live incident. It stops being latent the moment a second tip entry point ships.
--
-- Found by the money-edge-webhook audit pass, 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The gate, with the Stripe key split out of the slot key ──────────────────
-- Body is 20260814090000's, unchanged except for the two `stripe_key` fields: the retire
-- rename, the live-reservation reuse, the unique_violation collapse and the cap reporting
-- all still do exactly what that migration proved they do.
create or replace function public.reserve_tip_slot(p_booking uuid, p_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key    text;
  v_id     uuid;
  v_earner uuid;
  v_reason text;
  v_head   jsonb;
begin
  if p_booking is null or p_cents is null or p_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'tip_invalid');
  end if;

  select b.earner_id into v_earner from public.bookings b where b.id = p_booking;
  if v_earner is null then
    return jsonb_build_object('ok', false, 'reason', 'tip_invalid');
  end if;

  -- The SLOT key: deterministic per (booking, cents) because the unique index on it IS
  -- the double-tap collapse. It is NOT the Stripe idempotency key any more — see the
  -- header; a released slot key that Stripe still remembers replays the first charge.
  v_key := 'resv_' || p_booking::text || '_' || p_cents::text;

  -- RETIRE a reservation that timed out without ever being confirmed: free the key so
  -- this attempt can take it, but leave reserved_until in the past so the row still does
  -- not consume headroom, and leave the ROW so ctl_earner_credit_missing can raise it. A
  -- delete here would erase the only trace of an invocation that may have charged a card
  -- before it died.
  --
  -- Retire by RENAMING, never by nulling. A nulled key makes the retired row
  -- unaddressable forever: release_tip_reservation matches on `reservation_key = p_key`
  -- and null equals nothing, while confirm_tip_charge would find the NEW row under that
  -- key. The row would then sit uncredited, PI-null and key-null — a permanent finding no
  -- remedy can clear, which is the exact shape 20260814050000 was written to end. Worse,
  -- an operator following the printed remedy with the reconstructed key would release the
  -- LIVE reservation instead and hand headroom back mid-charge.
  --
  -- Suffixing with the row id keeps it unique (the partial unique index still holds),
  -- keeps it addressable, and makes it obvious in the table which rows are corpses.
  update public.tip_ledger
     set reservation_key = v_key || '_retired_' || id::text
   where reservation_key = v_key
     and reserved_until is not null
     and reserved_until <= now()
     and coalesce(credited, false) = false
     and payment_intent_id is null;

  -- REUSE an existing live reservation for this exact slot, BEFORE trying to insert.
  --
  -- This cannot be left to the insert's unique_violation branch. trg_guard_tip_caps is a
  -- BEFORE INSERT trigger, so on a repeated identical tip it evaluates the caps INCLUDING
  -- the reservation already held — 15000 + 15000 against a 20000 booking cap — and raises
  -- tip_cap_booking before the unique index is ever consulted. The double-tap collapse
  -- would never fire, and the poster would be told their own second tap put them over the
  -- cap.
  --
  -- An EXPIRED reservation was renamed by the retire step above, and a CONFIRMED one has
  -- its key nulled, so neither matches here — only a live slot is reused. Reuse returns
  -- the SAME row, hence the same stripe_key, which is what keeps a double tap to one
  -- PaymentIntent now that the two keys are separate.
  select id into v_id
    from public.tip_ledger
   where reservation_key = v_key
     and coalesce(credited, false) = false;
  if v_id is not null then
    return jsonb_build_object(
      'ok', true, 'key', v_key, 'reservation_id', v_id,
      'stripe_key', 'resv_' || v_id::text
    );
  end if;

  begin
    insert into public.tip_ledger
      (booking_id, payment_intent_id, reservation_key, earner_id, amount_cents, reserved_until)
    values
      (p_booking, null, v_key, v_earner, p_cents, now() + interval '10 minutes')
    returning id into v_id;
  exception
    when unique_violation then
      -- Someone already holds this exact slot. Fall through and reuse it — that IS the
      -- double-tap collapse, and it must not consume a second slot.
      v_id := null;
    when check_violation then
      v_reason := sqlerrm;
      -- Only the cap trigger speaks this dialect. Anything else (a table CHECK, say) is
      -- not a cap decision and must not be reported to the poster as one.
      if v_reason not like 'tip_cap_%' then
        raise;
      end if;
  end;

  if v_reason is not null then
    v_head := public.tip_headroom_cents(p_booking);
    return jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'headroom_cents', greatest(0, coalesce((v_head->>'headroom_cents')::bigint, 0))
    );
  end if;

  if v_id is null then
    select id into v_id from public.tip_ledger where reservation_key = v_key;
    if v_id is null then
      -- The conflicting row vanished between the insert and this read. Refuse rather than
      -- charge: an unreserved charge is the bug this function exists to end.
      return jsonb_build_object('ok', false, 'reason', 'tip_reserve_failed');
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'key', v_key, 'reservation_id', v_id,
    'stripe_key', 'resv_' || v_id::text
  );
end;
$fn$;

revoke execute on function public.reserve_tip_slot(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_tip_slot(uuid, integer) to service_role;

-- ── The stale-tip control names the key the charge actually went out under ───
-- ⚠️ THE ESCROW ARM STAYS, verbatim. This control is a UNION of two unrelated shapes and
-- only the TIP half is changing. run_control auto-resolves anything a control stops
-- returning, scoped only by control_key, so a redefinition that dropped the escrow arm
-- would silently close every open "captured from a poster, never credited to the earner"
-- finding on the next sweep — and nothing else can see those.
create or replace function public.ctl_earner_credit_missing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$select
  p.id::text as entity_id,
  jsonb_build_object(
    'kind', 'escrow_capture_not_credited',
    'booking_id', p.booking_id,
    'earner_id', b.earner_id,
    'payment_intent_id', p.payment_intent_id,
    'earner_amount_cents', p.earner_amount_cents,
    'fee_cents', p.fee_cents,
    'captured_at', p.captured_at,
    'minutes_stale', round(extract(epoch from now() - coalesce(p.captured_at, p.created_at, 'epoch'::timestamptz)) / 60)::int,
    'remedy', 'service_role: select public.credit_earnings(<this payments.id>)'
  ) as detail
from public.payments p
join public.bookings b on b.id = p.booking_id
where p.status = 'captured'
  and coalesce(p.earnings_credited, false) = false
  and coalesce(p.captured_at, p.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'
union all
select
  t.id::text,
  jsonb_build_object(
    'kind', case when t.payment_intent_id is not null
                 then 'tip_charged_not_credited'
                 else 'tip_reservation_unconfirmed' end,
    'booking_id', t.booking_id,
    'earner_id', t.earner_id,
    'payment_intent_id', t.payment_intent_id,
    'amount_cents', t.amount_cents,
    'charged_at', t.created_at,
    'minutes_stale', round(extract(epoch from now() - coalesce(t.created_at, 'epoch'::timestamptz)) / 60)::int,
    -- The row's OWN slot key, never a reconstruction. `resv_<booking>_<cents>` rebuilt
    -- from the columns is correct only for a LIVE reservation; on a retired one that
    -- string now names whichever reservation took the slot afterwards, so an operator
    -- following this remedy would release a live reservation mid-charge.
    'reservation_key', t.reservation_key,
    -- The Stripe idempotency key is the reservation ROW as of 20260906014000. It used to
    -- be the slot key, which is why a released key replayed the previous charge.
    'stripe_idempotency_key', 'resv_' || t.id::text,
    -- Rows written before that migration were charged under the slot-key form, so an
    -- operator hunting a stranded PaymentIntent has to be able to try the old shape too.
    -- Naming one truth for both eras would send them to the wrong charge.
    'legacy_stripe_idempotency_key',
      coalesce(split_part(t.reservation_key, '_retired_', 1),
               'resv_' || t.booking_id::text || '_' || t.amount_cents::text),
    'remedy', case when t.payment_intent_id is not null
      then 'The card WAS charged and the earner was not credited. service_role: select '
           'public.confirm_tip_charge(reservation_key, payment_intent_id) — or, for a row '
           'predating reservations, public.claim_and_credit_tip(payment_intent_id, booking_id, '
           'earner_id, amount_cents). Refunding the PaymentIntent in Stripe is the alternative.'
      else 'A tip slot was reserved and never confirmed, so stripe-tip died mid-charge. Look '
           'up the PaymentIntent Stripe created under stripe_idempotency_key in this detail '
           '(and under legacy_stripe_idempotency_key if this row predates 2026-09-06). If it '
           'SUCCEEDED the poster was charged and the earner was not: service_role select '
           'public.confirm_tip_charge(<reservation_key from this detail>, <pi>). If it does not exist '
           'or did not succeed, no money moved: service_role select '
           'public.release_tip_reservation(<reservation_key from this detail>). The row is '
           'already excluded from the tip caps, so it is holding no headroom while you decide.'
    end
  )
from public.tip_ledger t
where coalesce(t.credited, false) = false
  and coalesce(t.created_at, 'epoch'::timestamptz) < now() - interval '15 minutes'$ctl$;
revoke execute on function public.ctl_earner_credit_missing() from public, anon, authenticated;


-- ── Prove the second tip gets a key Stripe has never seen, rolled back ───────
do $$
declare
  uid uuid; jid uuid; bid uuid;
  r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb;
  det jsonb;
  n_escrow integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'tip idempotency probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;

  -- ══ 1. A double tap still collapses: same row, so the same Stripe key ══════
  r1 := public.reserve_tip_slot(bid, 1000);
  if not coalesce((r1->>'ok')::boolean, false) then
    raise exception 'a tip inside the cap was refused: %', r1;
  end if;
  if (r1->>'stripe_key') is distinct from ('resv_' || (r1->>'reservation_id')) then
    raise exception 'stripe_key is not the reservation row: %', r1;
  end if;

  r2 := public.reserve_tip_slot(bid, 1000);
  if (r2->>'reservation_id') is distinct from (r1->>'reservation_id')
     or (r2->>'stripe_key') is distinct from (r1->>'stripe_key') then
    raise exception 'FIX BROKE THE DOUBLE-TAP COLLAPSE: a repeated identical tip got a second key (% vs %)',
      r2->>'stripe_key', r1->>'stripe_key';
  end if;
  raise notice 'a double tap reuses one reservation and one Stripe key (%), so one PaymentIntent', r1->>'stripe_key';

  -- ══ 2. THE BUG: confirm the first tip, then tip the same amount again ══════
  if not public.confirm_tip_charge(r1->>'key', 'pi_tip_idem_probe_1') then
    raise exception 'could not confirm the first tip';
  end if;

  r3 := public.reserve_tip_slot(bid, 1000);
  if not coalesce((r3->>'ok')::boolean, false) then
    raise exception 'the second legitimate tip was refused: % — the count cap allows three', r3;
  end if;
  if (r3->>'reservation_id') = (r1->>'reservation_id') then
    raise exception 'the second tip reused the confirmed row; the probe cannot discriminate';
  end if;

  -- The OLD behaviour, on this exact pair of rows: the slot key is byte-identical, so
  -- Stripe would answer the second create with the first PaymentIntent and no card would
  -- be charged. This is the failure, demonstrated rather than asserted in prose.
  if (r3->>'key') is distinct from (r1->>'key') then
    raise exception 'probe cannot discriminate: the slot keys already differ (% vs %)',
      r3->>'key', r1->>'key';
  end if;
  raise notice 'OLD key: the second tip reuses the string % — Stripe replays the first charge for 24h', r1->>'key';

  -- ══ 3. THE FIX: the Stripe key is the row, so the second tip is a new charge ══
  if (r3->>'stripe_key') = (r1->>'stripe_key') then
    raise exception 'FIX FAILED: the second reservation carries the first charge''s Stripe key (%)',
      r3->>'stripe_key';
  end if;
  raise notice 'discriminates: same slot key %, different Stripe key % vs %',
    r1->>'key', r1->>'stripe_key', r3->>'stripe_key';

  -- ══ 4. A released reservation likewise gets a fresh key, so a card retry works ══
  if not public.release_tip_reservation(r3->>'key') then
    raise exception 'release_tip_reservation did not remove a live reservation';
  end if;
  r4 := public.reserve_tip_slot(bid, 1000);
  if not coalesce((r4->>'ok')::boolean, false) then
    raise exception 'could not re-reserve after a release: %', r4;
  end if;
  if (r4->>'stripe_key') in ((r1->>'stripe_key'), (r3->>'stripe_key')) then
    raise exception 'FIX FAILED: a retry after a decline replays a key Stripe already answered';
  end if;
  raise notice 'a retry after a decline gets key %, so a replaced card is not rejected as idempotency_error',
    r4->>'stripe_key';

  -- ══ 5. The control prints the key the charge actually went out under ═══════
  update public.tip_ledger set created_at = now() - interval '30 minutes'
   where booking_id = bid and coalesce(credited, false) = false;
  select detail into det
    from public.ctl_earner_credit_missing()
   where entity_id = (r4->>'reservation_id');
  if det is null then
    raise exception 'the control cannot see a stale reservation at all';
  end if;
  if (det->>'stripe_idempotency_key') is distinct from (r4->>'stripe_key') then
    raise exception 'the control prints % but the charge went out under %',
      det->>'stripe_idempotency_key', r4->>'stripe_key';
  end if;
  if (det->>'legacy_stripe_idempotency_key') is distinct from (r4->>'key') then
    raise exception 'the pre-2026-09-06 form is not carried for older rows: %', det;
  end if;
  raise notice 'the operator is pointed at %, not at the slot key that names the previous charge',
    det->>'stripe_idempotency_key';

  -- ══ 6. The escrow arm of the same control is untouched ════════════════════
  -- A redefinition that lost it would auto-resolve every open capture-not-credited
  -- finding on the next sweep, on real unremediated money.
  select count(*) into n_escrow
    from public.ctl_earner_credit_missing()
   where (detail->>'kind') = 'escrow_capture_not_credited';
  if n_escrow is null then
    raise exception 'the escrow arm no longer returns rows';
  end if;
  raise notice 'the escrow arm still evaluates (% row(s)), so no capture finding is auto-resolved', n_escrow;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'tip idempotency probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
