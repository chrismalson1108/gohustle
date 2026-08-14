// Captures a previously-authorized PaymentIntent after both parties verify job completion.
// Stripe automatically transfers earner_amount to their Connect account on capture.
import Stripe from 'npm:stripe@22';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { logServerError, errMessage } from '../_shared/logError.ts';
import { one } from '../_shared/pgrest.ts';

// Number(null) is 0 and Number.isFinite(0) is true, so a bare
// `Number.isFinite(Number(x)) ? Number(x) : FALLBACK` resolves a NULL rate to 0 bps —
// a free gig — rather than to the fallback. These columns are NOT NULL DEFAULT 1000
// today so it cannot fire, but the pattern must not survive to the next nullable
// column. Test for null/undefined first, and require a positive rate.
function safeBps(v: unknown, fallback = 1000): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  // >= 0, NOT > 0. A pinned ZERO is legitimate and common — it is exactly what a
  // "first 2 gigs free" promotion and a 0% loyalty rung store. The previous `n > 0`
  // mapped it to the 1000 fallback, so the flagship presets would have charged the
  // full fee. That is the same class of bug as Number(null)===0, which this helper was
  // written to fix: a guard that cannot tell "absent" from "legitimately zero".
  // Negative is still nonsense and still falls back.
  return Number.isFinite(n) && n >= 0 && n <= 3000 ? Math.trunc(n) : fallback;
}


// ── Claim the payment row before the irreversible Stripe call ───────────────
//
// The split has to be persisted BEFORE capturing (a fast payment_intent.succeeded
// webhook credits from whatever the row holds), but it used to be written with
// `.eq('id', …)` alone — no status predicate, no returned-row check. Two overlapping
// captures then interleave, and the earner is credited whichever number lost the race:
//
//   R1 (full)    writes the full split
//   R2 (50%)     writes the reduced split
//   R1           captures the FULL amount at Stripe, flips status to 'captured'
//   credit_earnings reads the REDUCED figure and credits that
//
// The mirror is worse: Stripe collects half while the row keeps the full split, so the
// poster pays $50 and the app tells the earner they were paid $100. credit_earnings is
// exactly-once but VALUE-blind — it credits whatever the row holds at that instant — and
// both ctl_payment_ledger_impossible and ctl_earnings_total_drift derive their expected
// value from the same column, so neither can see it.
//
// `authorized` is the only status that reaches here: cancelled/failed return
// HOLD_EXPIRED above, and captured skips this block entirely. So the predicate costs
// nothing on the happy path and on a legitimate retry after a Stripe failure (the row
// is still authorized), while a write arriving after another runner flipped the status
// matches zero rows and is refused instead of corrupting a settled ledger.
//
// accept-booking:83 has used this exact shape since it was written; the money path was
// the one that did not.
async function claimForCapture(
  supabase: SupabaseClient,
  paymentId: string,
  feeCents: number,
  earnerAmountCents: number,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('payments')
    .update({ fee_cents: feeCents, earner_amount_cents: earnerAmountCents })
    .eq('id', paymentId)
    .eq('status', 'authorized')
    .select('id');
  // Fail closed on an error too — an unverifiable claim is not a claim.
  return !error && Array.isArray(data) && data.length === 1;
}

// ── Reconcile the persisted split against what Stripe actually collected ────
//
// The claim above closes the race on OUR side. This closes it on Stripe's: the capture
// response carries `amount_received`, the only authoritative figure, and writing the
// split from it means the ledger cannot disagree with the money even if the request we
// sent and the amount collected differ. earner-claim-payment:212 already states this
// rule — "STRIPE is the sole source of truth… we NEVER pre-write a computed amount" —
// and stripe-webhook's succeeded handler re-derives the same way. This path kept the
// pre-write, which it must, so it reconciles immediately after instead.
//
// Normal case: received === requested, nothing is corrected, the values are untouched.
function reconcileToStripe(
  pi: Stripe.PaymentIntent,
  requestedCents: number,
  feeCents: number,
  earnerCents: number,
): { receivedCents: number; feeCents: number; earnerCents: number; corrected: boolean } {
  const received = typeof pi.amount_received === 'number' ? pi.amount_received : 0;
  // A zero/absent amount_received on a successful capture means Stripe told us nothing
  // usable. Keep the computed split rather than zeroing a real payout on a parse miss.
  if (received <= 0 || received === requestedCents) {
    return { receivedCents: requestedCents, feeCents, earnerCents, corrected: false };
  }
  // Same proportional rule the webhook applies, so the two paths cannot disagree about
  // the same PaymentIntent.
  const ratio = requestedCents > 0 ? Math.min(1, received / requestedCents) : 1;
  const fee = Math.min(received, Math.round(feeCents * ratio));
  return { receivedCents: received, feeCents: fee, earnerCents: received - fee, corrected: true };
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Hoisted so the terminal catch can identify the failure. The service client,
  // `user` and `bookingId` are all declared inside the try below and are therefore
  // out of scope there; without these the error row names only the function.
  let errBookingId: string | null = null;
  let errUserId: string | null = null;

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    errUserId = user?.id ?? null;
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    // Optional pct (partial capture for a dispute) releases the remainder of the
    // hold back to the poster. Policy: a reduced payout is allowed ONLY with a stated
    // reason (recorded below as an audit trail) and is FLOORED at 50% — reaching the
    // verify step requires the poster's own mark-done, so the worker earned at least
    // half; a genuine no-show should be cancelled (full refund), not verified at ~0%.
    // This prevents a poster from capturing completed work at a trivial amount.
    const { bookingId, pct, disputeReason, disputePhotos } = await req.json();
    errBookingId = typeof bookingId === 'string' ? bookingId : null;
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    const wantsPartial = typeof pct === 'number' && pct < 1;
    if (wantsPartial && (!disputeReason || !String(disputeReason).trim())) {
      return json({
        error: 'DISPUTE_REASON_REQUIRED',
        message: 'To release less than the full amount, describe the problem so it can be recorded.',
      }, 400);
    }
    // Hard floor at 50%; clamp to [0.5, 1]. Full capture when pct is absent/>=1.
    const capturePctFinal = wantsPartial ? Math.min(1, Math.max(0.5, pct)) : 1;

    // Authorization (IDOR guard): capture releases escrow to the earner, so only
    // the poster who owns this booking's job may trigger it, and only once the
    // work is done. Without this any signed-in user could settle others' bookings.
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'Booking is not ready to capture' }, 409);
    }

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited, fee_bps, fee_credit_cents, poster_discount_cents')
      .eq('booking_id', bookingId)
      .single();

    if (pErr || !payment) return json({ error: 'Payment not found' }, 404);

    // The authorization can lapse before capture — Stripe auto-cancels an uncaptured
    // hold ~7 days out, and the webhook then marks the row 'cancelled'. Surface a
    // clear, actionable error instead of throwing a generic 500 on capture().
    if (payment.status === 'cancelled' || payment.status === 'failed') {
      return json({
        error: 'HOLD_EXPIRED',
        message: 'The card hold expired before payment could be released. Re-confirm this booking to place a new hold, then verify again.',
      }, 409);
    }

    let earnerAmountCents = payment.earner_amount_cents ?? 0;
    // The final gig value this capture settles at, for the promo budget. Null means the
    // capture branch never ran (already captured) and there is nothing new to settle.
    let capturedGigCents: number | null = null;

    // Re-check the earner's Connect account is STILL payout-capable before we move
    // money. It was verified at accept time, but Stripe can restrict an account in
    // the accept→verify window (the webhook demotes onboarded=false). Capturing into
    // a restricted destination would hold the funds there while we credit the
    // dashboard anyway. Only gate a fresh capture — a retry on an already-captured
    // payment should still fall through to crediting.
    if (payment.status !== 'captured') {
      const { data: earnerAcct } = await supabase
        .from('stripe_accounts').select('onboarded').eq('user_id', booking.earner_id).single();
      if (!earnerAcct?.onboarded) {
        return json({
          error: 'EARNER_PAYOUTS_DISABLED',
          message: "The earner's payout account is no longer active. They need to re-verify it before payment can be released.",
        }, 409);
      }
    }

    // Capture the hold if not already captured (idempotent on retry).
    if (payment.status !== 'captured') {
      const capturePct = capturePctFinal; // validated + floored above

      // The FULL fee for this authorization, computed ONCE from two immutable
      // inputs: amount_cents (never rewritten) and fee_bps (pinned at authorization
      // by trg_z_pin_payment_fee_bps, 20260806050000). Both branches below scale
      // from this, so a partial capture and a retry of that partial always agree.
      //
      // Replaces `Math.round(amount_cents * 0.10)` in two places. The rate is no
      // longer a literal, but the idempotency property is unchanged and is still the
      // reason this is derived rather than read from the mutable fee_cents column.
      // Recover the ORIGINAL gig amount: amount_cents is what Stripe is holding, which
      // with a poster discount is already net of it. Every input here is immutable —
      // amount_cents is never rewritten, and fee_bps / fee_credit_cents /
      // poster_discount_cents are pinned by trg_z_pin_payment_fee_bps — so this stays
      // idempotent under retry, which is the property the partial branch depends on.
      const discountCents = Math.max(0, Math.trunc(Number(payment.poster_discount_cents) || 0));
      const creditCents = Math.max(0, Math.trunc(Number(payment.fee_credit_cents) || 0));
      const gigAmountCents = (payment.amount_cents || 0) + discountCents;
      // Defaults to the full authorized value; the partial branch narrows it.
      capturedGigCents = gigAmountCents;

      const { data: fullFeeCalc, error: feeErr } = await supabase.rpc('platform_fee_after_credit', {
        p_amount_cents: gigAmountCents,
        p_fee_bps: safeBps(payment.fee_bps),
        p_credit_cents: creditCents,
      });
      if (feeErr || !Number.isFinite(Number(fullFeeCalc))) {
        // FAIL CLOSED — refuse to capture rather than guess a fee. Money that moves
        // at a made-up rate is worse than money that has not moved yet.
        await logServerError('stripe-capture-payment',
          `fee computation failed for payment ${payment.id}: ${feeErr?.message ?? 'non-numeric'}`,
          { booking_id: bookingId, payment_id: payment.id }, { fatal: true });
        return json({ error: 'Could not price this capture. Please try again.' }, 503);
      }
      // The platform's share is what is left of the fee after funding the poster's
      // discount out of it. The earner's side is unaffected by that discount.
      const fullFeeForAuth = Math.max(0, Number(fullFeeCalc) - discountCents);
      if (capturePct < 1) {
        const captureCents = Math.max(1, Math.round((payment.amount_cents || 0) * capturePct));
        // The real, final gig value — what the promo budget should actually be charged.
        // Derived from the same immutable inputs as the fee, so it survives a retry.
        //
        // The discount is SCALED. captureCents is a percentage of the already-discounted
        // authorization, so the poster only received `pct` of the discount — on a $100
        // gig with a $3.55 discount settled at 50% they paid $48.23 rather than $50.00,
        // i.e. $1.77 of benefit. Adding the FULL $3.55 back overstated the captured gig
        // value (5178c against an actual 5001c) and burned the campaign's budget faster
        // than the campaign actually delivered.
        //
        // NOTE this does NOT change what the platform collects: the discount is
        // subtracted from the fee BEFORE the fee is scaled, so round((fee − disc) × pct)
        // already funds only the scaled share. Verified live: 173c collected vs 172c
        // ideal, a 1c rounding difference. I first read this as a 2× over-funding and
        // the arithmetic disproved it — only the budget accounting was wrong.
        capturedGigCents = captureCents + Math.round(discountCents * capturePct);
        // Derive the fee from the IMMUTABLE authorized amount, never from the
        // mutable fee_cents column: this branch rewrites fee_cents below, so if a
        // first partial attempt persisted the reduced fee and then failed (Stripe
        // error / timeout), a retry reading fee_cents would scale the ALREADY-reduced
        // value again (fee * pct²) — the platform under-collects and the earner is
        // over-credited. amount_cents is never overwritten, so round(fullFee * pct)
        // yields the same result on the first call and every retry.
        const fullFeeCents = fullFeeForAuth;

        // ── Re-floor at the CAPTURED amount ──────────────────────────────────
        //
        // Scaling the full fee is right for the percentage part and WRONG for the
        // floor. platform_fee_cents floors every fee at `ceil(amount*0.029) + 30 + 25`
        // — Stripe's processing plus a 25c margin — so fullFeeCents may already BE that
        // floor. Multiplying it by pct scales the fixed 30c+25c down, while Stripe's own
        // fixed 30c on the captured amount does not scale. The platform then pays to
        // settle a dispute.
        //
        // Verified against live pg_proc, both reachable today:
        //   $200 gig, 765c credit, 50%  → scaled 318 vs Stripe cost 320  = -2c
        //   $10 gig,  NO credit,   50%  → scaled  42 vs Stripe cost  45  = -3c
        //
        // The second needs no promotion at all: any small gig settled below 100% loses
        // money, and 0.5 is a one-tap chip in the poster's own Verify sheet
        // (CompletionModal PCTS = [0.9, 0.75, 0.5]).
        //
        // Floor via the RPC with 0 bps — that returns exactly the floor for an amount,
        // from the ONE definition of the fee, rather than reimplementing it here.
        // Still idempotent: captureCents derives from the immutable amount_cents, never
        // from the mutable fee_cents column, so a retry recomputes the same number.
        const { data: floorCalc, error: floorErr } = await supabase.rpc('platform_fee_cents', {
          p_amount_cents: captureCents,
          p_fee_bps: 0,
        });
        if (floorErr || !Number.isFinite(Number(floorCalc))) {
          await logServerError('stripe-capture-payment',
            `capture floor computation failed for payment ${payment.id}: ${floorErr?.message ?? 'non-numeric'}`,
            { booking_id: bookingId, payment_id: payment.id }, { fatal: true });
          return json({ error: 'Could not price this capture. Please try again.' }, 503);
        }
        const scaledFee = Math.round(fullFeeCents * capturePct);
        const feeCents = Math.min(captureCents, Math.max(scaledFee, Number(floorCalc)));
        earnerAmountCents = captureCents - feeCents;

        // Persist the REDUCED net BEFORE capturing. Capturing emits
        // payment_intent.succeeded, and the webhook credits earnings from whatever
        // earner_amount_cents the row holds — if we wrote it AFTER the capture, a
        // fast webhook could read the stale full amount and over-credit the earner.
        // Keep amount_cents as the originally-AUTHORIZED hold (audit record); the
        // captured total is derivable as earner_amount_cents + fee_cents.
        //
        // CLAIM the row on the way past (see claimForCapture). Without the status
        // predicate this write lands on an already-captured row, and the earner is
        // credited whatever the loser of the race wrote.
        if (!await claimForCapture(supabase, payment.id, feeCents, earnerAmountCents)) {
          return json({
            error: 'BOOKING_CHANGED',
            message: 'This payment was already being released. Refresh to see the outcome.',
          }, 409);
        }
        const capturedPi = await stripe.paymentIntents.capture(payment.payment_intent_id, {
          amount_to_capture: captureCents,
          application_fee_amount: feeCents,
        });
        // Stripe is the source of truth for what was collected — reconcile before the
        // status flip, because that flip is what lets credit_earnings run.
        const settled = reconcileToStripe(capturedPi, captureCents, feeCents, earnerAmountCents);
        if (settled.corrected) {
          await logServerError('stripe-capture-payment',
            `capture on ${payment.payment_intent_id}: asked for ${captureCents}, Stripe ` +
            `collected ${settled.receivedCents}. Split re-derived from amount_received.`,
            { booking_id: bookingId, payment_id: payment.id }, { fatal: false });
        }
        earnerAmountCents = settled.earnerCents;
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
          fee_cents: settled.feeCents,
          earner_amount_cents: settled.earnerCents,
        }).eq('id', payment.id);

        // ── Give back the part of the credit this capture could not use ──────
        //
        // consume_fee_credit debits the credit at BOOKING, sized to the fee on the FULL
        // gig. Settle below 100% and the fee shrinks, so the credit can only offset a
        // smaller amount — and the rest was simply gone: the ledger row stays 'applied',
        // release_booking_benefits early-returns once captured, and its trigger fires
        // only on declined/cancelled.
        //
        // Measured on a $200 gig with a 765c credit at 50%: the credit delivered 355c of
        // value and 410c evaporated, more than half.
        //
        // settle_booking_benefits already relaxes a PROMOTION's budget on this exact
        // event; it iterates promo_redemptions only, so referral credits were left out of
        // a rule the platform already follows. And consume_fee_credit itself refuses to
        // forfeit a partially-usable credit — "splitting rather than forfeiting is the
        // difference between a credit and a coupon". This is that, one step later.
        //
        // ── IT RUNS HERE, AFTER THE CAPTURE — NOT BEFORE ─────────────────────
        //
        // Releasing a credit is one-way as far as this function is concerned: the RPC is
        // idempotent on the DELIVERED figure, so a later call carrying a LARGER delivered
        // value returns 0 rather than taking the release back. So it must never sit on a
        // path that can still abort. It used to sit above claimForCapture, and that abort
        // was reachable — the earner claims the same ghosted gig, earner-claim-payment:285
        // flips payments.status to 'captured', our claim then matches zero rows and 409s
        // BOOKING_CHANGED with 410c of the $200/765c case already handed back against a
        // capture that never happened, free to be spent on another booking. Nothing would
        // have caught it either: ctl_credit_stranded_on_dead_booking only looks the other
        // way (still 'applied' on a declined/cancelled booking).
        //
        // Below the status flip is also the same rule settle_booking_benefits follows a
        // few lines down — money first, bookkeeping after.
        //
        // Delivered value = what the fee WOULD have been without the credit, minus what
        // it actually is. Non-fatal: the money has moved, and a bookkeeping retry must
        // never fail a settled capture. return_unused_fee_credit is idempotent on the
        // delivered figure, so the hourly sweep can safely re-run it.
        if (creditCents > 0) {
          try {
            const { data: noCreditCalc } = await supabase.rpc('platform_fee_cents', {
              p_amount_cents: gigAmountCents,
              p_fee_bps: safeBps(payment.fee_bps),
            });
            if (Number.isFinite(Number(noCreditCalc))) {
              const noCreditFull = Math.max(0, Number(noCreditCalc) - discountCents);
              const noCreditAtCapture = Math.min(
                captureCents,
                Math.max(Math.round(noCreditFull * capturePct), Number(floorCalc)),
              );
              const delivered = Math.max(0, noCreditAtCapture - feeCents);
              const { data: returned, error: retErr } = await supabase.rpc('return_unused_fee_credit', {
                p_booking: bookingId,
                p_delivered_cents: delivered,
              });
              if (retErr) throw retErr;
              if (Number(returned) > 0) {
                console.log(`stripe-capture-payment: returned ${returned}c of unused fee credit on ${bookingId}`);
              }
            }
          } catch (e) {
            await logServerError('stripe-capture-payment',
              `could not return unused fee credit on booking ${bookingId}: ${String((e as Error)?.message ?? e)}`,
              { booking_id: bookingId, payment_id: payment.id });
          }
        }
      } else {
        // Recompute the FULL split from the AUTHORIZED amount (amount_cents is never
        // overwritten) and persist it BEFORE capturing — same reason as the partial
        // branch: capture emits payment_intent.succeeded and the webhook credits from
        // whatever earner_amount_cents the row holds, so a prior failed partial
        // attempt's stale reduced value must be corrected before a racing webhook can
        // read it (otherwise the earner is under-credited vs. the full amount paid).
        const fullFee = fullFeeForAuth;
        const fullAuthCents = payment.amount_cents || 0;
        earnerAmountCents = fullAuthCents - fullFee;
        if (!await claimForCapture(supabase, payment.id, fullFee, earnerAmountCents)) {
          return json({
            error: 'BOOKING_CHANGED',
            message: 'This payment was already being released. Refresh to see the outcome.',
          }, 409);
        }
        const capturedPi = await stripe.paymentIntents.capture(payment.payment_intent_id);
        const settled = reconcileToStripe(capturedPi, fullAuthCents, fullFee, earnerAmountCents);
        if (settled.corrected) {
          await logServerError('stripe-capture-payment',
            `capture on ${payment.payment_intent_id}: authorized ${fullAuthCents}, Stripe ` +
            `collected ${settled.receivedCents}. Split re-derived from amount_received.`,
            { booking_id: bookingId, payment_id: payment.id }, { fatal: false });
        }
        earnerAmountCents = settled.earnerCents;
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
          fee_cents: settled.feeCents,
          earner_amount_cents: settled.earnerCents,
        }).eq('id', payment.id);
      }
    }

    // Credit the earner's earnings dashboard with the NET payout — atomically and
    // exactly once. credit_earnings claims the credit via a single conditional
    // UPDATE (flips earnings_credited only if it was false) and increments earnings
    // in the SAME transaction, so concurrent captures or the webhook can't
    // double-credit, and a transient failure rolls back so a retry still credits.
    void earnerAmountCents; // (now read inside the RPC from the payments row)
    await supabase.rpc('credit_earnings', { p_payment_id: payment.id });

    // Settle the promo budget against what was ACTUALLY captured.
    //
    // At booking, consume_promo_grant charges the campaign the worst-case benefit so
    // in-flight work cannot oversubscribe the budget. This is the other half: now that
    // the real figure is known — and it is lower on every partial capture — give the
    // difference back. Without it a campaign is permanently charged the maximum per
    // redemption and exhausts long before its budget is really spent.
    //
    // Deliberately AFTER the money has moved and deliberately non-fatal: a budget that
    // is momentarily over-charged is a reporting error, while a throw here would fail a
    // capture whose funds have already settled. ctl_benefit_never_settled catches any
    // redemption this misses.
    if (capturedGigCents !== null) {
      const { error: settleErr } = await supabase.rpc('settle_booking_benefits', {
        p_booking: bookingId,
        p_amount_cents: capturedGigCents,
      });
      if (settleErr) {
        await logServerError('stripe-capture-payment',
          `benefit settle failed for booking ${bookingId}: ${settleErr.message}`,
          { booking_id: bookingId, payment_id: payment.id });
      }
    }

    // Record the dispute server-side so a reduced payout ALWAYS has an audit trail
    // (the client no longer inserts this). Idempotent per booking so a capture retry
    // doesn't duplicate the row.
    if (capturePctFinal < 1) {
      const { data: existingDispute } = await supabase
        .from('disputes').select('id').eq('booking_id', bookingId).maybeSingle();
      if (!existingDispute) {
        // Evidence the poster attached when reporting the problem. Only the caller's
        // OWN storage paths are accepted: the client supplies these, and a poster who
        // could name any path would be able to pull another user's private photos into
        // a record the earner and support both read. completion-photos is written
        // owner-scoped under <userId>/, so that prefix is the check.
        const photos = Array.isArray(disputePhotos)
          ? disputePhotos
              .filter((p: unknown): p is string => typeof p === 'string')
              .filter((p) => p.startsWith(`${user.id}/`))
              .slice(0, 6)
          : [];
        await supabase.from('disputes').insert({
          booking_id: bookingId,
          raised_by: user.id,
          reason: String(disputeReason).trim().slice(0, 500),
          pct_paid: Math.round(capturePctFinal * 100),
          photos,
        });
      }
    }

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-capture-payment:', err);
    // Land it where an operator will actually see it (/errors in the admin
    // console). This used to stop at console.error, so a money-path failure
    // was invisible unless someone was tailing Supabase function logs.
    await logServerError('stripe-capture-payment', `Escrow capture failed — the poster tried to pay and could not: ${errMessage(err)}`,
      { booking_id: errBookingId }, { fatal: true, userId: errUserId });
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
