// The escrow settlement, in ONE place.
//
// This is the money path lifted verbatim out of stripe-capture-payment so it has two
// callers instead of one. It moved here on 2026-09-09, when a poster reporting a
// problem stopped capturing immediately and became a PROPOSAL the earner can answer —
// which means the actual capture now happens later, from settle-disputes, on the hourly
// sweep. Two copies of this arithmetic would be two copies of: the 50% floor, the
// re-floor at Stripe cost, the discount scaling, the claim-before-capture race guard,
// the reconcile against amount_received, the recovery path for an instance that died
// mid-flight, and the unused-fee-credit return. Every one of those exists because it
// was got wrong once.
//
// Nothing in the body below was rewritten in the move. The only changes are mechanical:
// the six `return json(...)` refusals became returned objects so the caller decides the
// HTTP shape, and `booking.earner_id` / `capturePctFinal` became arguments.
import Stripe from 'npm:stripe@22.5.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';
import { logServerError } from './logError.ts';
import { payoutCapable } from './payoutCapable.ts';

// Reported on every error row this module writes. The two callers pass their own name
// so /errors still says which function was running.
let FN = 'settle-escrow';
export function setSettlementFnName(name: string): void { FN = name; }

export interface SettleOpts {
  bookingId: string;
  earnerId: string;
  /** 0.5 – 1. The caller floors and validates; this module trusts it. */
  capturePct: number;
}

export type SettleResult =
  | { ok: true; settledPct: number; capturedGigCents: number | null; earnerAmountCents: number }
  | { ok: false; error: string; message?: string; status: number };

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

// ── Give back the part of the credit a below-100% settlement could not use ───
//
// consume_fee_credit debits the credit at BOOKING, sized to the fee on the FULL gig.
// Settle below 100% and the fee shrinks, so the credit can only offset a smaller
// amount — and the rest was simply gone: the ledger row stays 'applied',
// release_booking_benefits early-returns once captured, and its trigger fires only on
// declined/cancelled.
//
// Measured on a $200 gig with a 765c credit at 50%: the credit delivered 355c of value
// and 410c evaporated, more than half.
//
// settle_booking_benefits already relaxes a PROMOTION's budget on this exact event; it
// iterates promo_redemptions only, so referral credits were left out of a rule the
// platform already follows. And consume_fee_credit itself refuses to forfeit a
// partially-usable credit — "splitting rather than forfeiting is the difference between
// a credit and a coupon". This is that, one step later.
//
// Delivered value = what the fee WOULD have been without the credit, minus what it
// actually is. Non-fatal: the money has moved, and a bookkeeping retry must never fail a
// settled capture. return_unused_fee_credit is idempotent on the DELIVERED figure, so
// the hourly sweep — and the recovery path below — can safely re-run it.
//
// EXTRACTED so it has two call sites. It used to be inline in the partial branch only,
// which meant it was reachable exactly once: on the first attempt, and never again. If
// that attempt died after the Stripe capture the credit was destroyed silently, because
// nothing looks in this direction (ctl_credit_stranded_on_dead_booking only checks a
// credit still 'applied' on a declined/cancelled booking).
async function returnUnusedFeeCredit(
  supabase: SupabaseClient,
  args: { bookingId: string; paymentId: string },
): Promise<void> {
  try {
    // ONE definition of the delivered figure, shared with record_refund
    // (20260906023000_refund_returns_the_credit_the_capture_delivered.sql). It used to be
    // computed inline here and a SECOND, different way in the refund path — and the two
    // disagreed on exactly the shapes this branch produces, a capture below 100% and any
    // capture carrying a poster discount, so a later partial refund handed the earner
    // back nothing. The RPC reads the row's PERSISTED split, so it is also the figure
    // Stripe actually settled on rather than the one we asked for (reconcileToStripe may
    // have moved it) — which is why every caller runs it after the status flip.
    const { data: delivered, error: delErr } = await supabase.rpc('fee_credit_delivered_cents', {
      p_payment_id: args.paymentId,
    });
    if (delErr) throw delErr;
    if (!Number.isFinite(Number(delivered))) return;
    const { data: returned, error: retErr } = await supabase.rpc('return_unused_fee_credit', {
      p_booking: args.bookingId,
      p_delivered_cents: Math.max(0, Number(delivered)),
    });
    if (retErr) throw retErr;
    if (Number(returned) > 0) {
      console.log(`${FN}: returned ${returned}c of unused fee credit on ${args.bookingId}`);
    }
  } catch (e) {
    await logServerError(FN,
      `could not return unused fee credit on booking ${args.bookingId}: ${String((e as Error)?.message ?? e)}`,
      { booking_id: args.bookingId, payment_id: args.paymentId });
  }
}

/**
 * Capture (or finish crediting) the escrow for one booking at `capturePct`.
 *
 * Idempotent: a booking whose payment is already `captured` skips the Stripe call and
 * falls through to the recovery block, which re-derives what was actually collected
 * from the ledger and repairs the bookkeeping that a died-mid-flight instance lost.
 */
export async function settleEscrow(
  stripe: Stripe,
  supabase: SupabaseClient,
  opts: SettleOpts,
): Promise<SettleResult> {
  const { data: payment, error: pErr } = await supabase
    .from('payments')
    .select('id, payment_intent_id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited, fee_bps, fee_credit_cents, poster_discount_cents')
    .eq('booking_id', opts.bookingId)
    .single();

  if (pErr || !payment) return { ok: false, error: 'Payment not found', status: 404 };

  // The authorization can lapse before capture — Stripe auto-cancels an uncaptured
  // hold ~7 days out, and the webhook then marks the row 'cancelled'. Surface a
  // clear, actionable error instead of throwing a generic 500 on capture().
  if (payment.status === 'cancelled' || payment.status === 'failed') {
    return {
      ok: false,
      error: 'HOLD_EXPIRED',
      message: 'The card hold expired before payment could be released. Re-confirm this booking to place a new hold, then verify again.',
      status: 409,
    };
  }
  // 'pending' is an intent that was minted but never confirmed — Stripe is holding
  // NOTHING, so there is nothing to capture. Same remedy, so the same error: place a
  // hold that actually completes. (This is only reachable on the recovery re-hold
  // path, where accept-booking does not run; the ordinary flow is promoted to
  // 'authorized' by accept-booking or by payment_intent.amount_capturable_updated
  // before anyone can verify.)
  if (payment.status === 'pending') {
    return {
      ok: false,
      error: 'HOLD_EXPIRED',
      message: 'The card hold was never completed, so there is nothing to release. Re-confirm this booking to place a new hold, then verify again.',
      status: 409,
    };
  }

  let earnerAmountCents = payment.earner_amount_cents ?? 0;
  // The final gig value this capture settles at, for the promo budget. Null means no
  // settlement is attributable to this request at all.
  let capturedGigCents: number | null = null;
  // The fraction of the authorization that was ACTUALLY collected, for the dispute
  // record. Set alongside capturedGigCents so the two can never disagree, and never
  // taken from the caller's `pct` — see the recovery block below.
  let settledPct = 1;

  // Hoisted out of the capture block: the recovery path below needs the same three
  // immutable inputs. amount_cents is never rewritten, and fee_bps / fee_credit_cents /
  // poster_discount_cents are pinned by trg_z_pin_payment_fee_bps, so every figure
  // derived from them is stable across retries.
  const discountCents = Math.max(0, Math.trunc(Number(payment.poster_discount_cents) || 0));
  const creditCents = Math.max(0, Math.trunc(Number(payment.fee_credit_cents) || 0));
  const gigAmountCents = (payment.amount_cents || 0) + discountCents;

  // Re-check the earner's Connect account is STILL payout-capable before we move
  // money. It was verified at accept time, but Stripe can restrict an account in
  // the accept→verify window (the webhook demotes onboarded=false). Capturing into
  // a restricted destination would hold the funds there while we credit the
  // dashboard anyway. Only gate a fresh capture — a retry on an already-captured
  // payment should still fall through to crediting.
  if (payment.status !== 'captured') {
    // Ask STRIPE when our cache says no. The flag going false is always correct, but it
    // going STALE at false is silent and expensive here: the work is done and the hold
    // is live, so refusing on a cached value leaves the worker unpaid AND the poster
    // uncharged until the authorization voids at ~7 days. Authorization-time already
    // re-verified for the milder case of merely blocking a booking; settle time did not.
    const cap = await payoutCapable(stripe, supabase, opts.earnerId);
    if (!cap.capable && !cap.unverifiable) {
      return {
        ok: false,
        error: 'EARNER_PAYOUTS_DISABLED',
        message: "The earner's payout account is no longer active. They need to re-verify it before payment can be released.",
        status: 409,
      };
    }
    if (cap.unverifiable) {
      // Stripe itself is unreachable. Refusing here would start the clock on a voided
      // hold over a transient API error, so proceed and let the capture be the thing
      // that fails if the destination really is restricted — that failure is loud,
      // immediate and reversible, which a silently expired authorization is not.
      await logServerError(FN,
        `could not verify payout capability for earner ${opts.earnerId} — proceeding to capture`,
        { booking_id: opts.bookingId, payment_id: payment.id });
    }
  }

  // Capture the hold if not already captured (idempotent on retry).
  if (payment.status !== 'captured') {
    const capturePct = opts.capturePct; // validated + floored by the caller

    // The FULL fee for this authorization, computed ONCE from two immutable
    // inputs: amount_cents (never rewritten) and fee_bps (pinned at authorization
    // by trg_z_pin_payment_fee_bps, 20260806050000). Both branches below scale
    // from this, so a partial capture and a retry of that partial always agree.
    //
    // Replaces `Math.round(amount_cents * 0.10)` in two places. The rate is no
    // longer a literal, but the idempotency property is unchanged and is still the
    // reason this is derived rather than read from the mutable fee_cents column.
    // The ORIGINAL gig amount, discount and credit are hoisted above the block: every
    // input is immutable — amount_cents is never rewritten, and fee_bps /
    // fee_credit_cents / poster_discount_cents are pinned by trg_z_pin_payment_fee_bps
    // — so this stays idempotent under retry, which is the property the partial branch
    // depends on.
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
      await logServerError(FN,
        `fee computation failed for payment ${payment.id}: ${feeErr?.message ?? 'non-numeric'}`,
        { booking_id: opts.bookingId, payment_id: payment.id }, { fatal: true });
      return { ok: false, error: 'Could not price this capture. Please try again.', status: 503 };
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
        await logServerError(FN,
          `capture floor computation failed for payment ${payment.id}: ${floorErr?.message ?? 'non-numeric'}`,
          { booking_id: opts.bookingId, payment_id: payment.id }, { fatal: true });
        return { ok: false, error: 'Could not price this capture. Please try again.', status: 503 };
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
        return {
          ok: false,
          error: 'BOOKING_CHANGED',
          message: 'This payment was already being released. Refresh to see the outcome.',
          status: 409,
        };
      }
      const capturedPi = await stripe.paymentIntents.capture(payment.payment_intent_id, {
        amount_to_capture: captureCents,
        application_fee_amount: feeCents,
      });
      // Stripe is the source of truth for what was collected — reconcile before the
      // status flip, because that flip is what lets credit_earnings run.
      const settled = reconcileToStripe(capturedPi, captureCents, feeCents, earnerAmountCents);
      if (settled.corrected) {
        await logServerError(FN,
          `capture on ${payment.payment_intent_id}: asked for ${captureCents}, Stripe ` +
          `collected ${settled.receivedCents}. Split re-derived from amount_received.`,
          { booking_id: opts.bookingId, payment_id: payment.id }, { fatal: false });
      }
      earnerAmountCents = settled.earnerCents;
      await supabase.from('payments').update({
        status: 'captured',
        captured_at: new Date().toISOString(),
        fee_cents: settled.feeCents,
        earner_amount_cents: settled.earnerCents,
      }).eq('id', payment.id);

      // The unused part of the fee credit goes back to the earner's ledger — see
      // returnUnusedFeeCredit above for why, and why it runs AFTER the status flip
      // rather than before it (money first, bookkeeping after; the release is one-way
      // and must never sit on a path that can still abort).
      //
      // `settledPct` records what was ACTUALLY collected so the recovery block after
      // the capture can re-derive this same call from the ledger alone.
      settledPct = capturePct;
      if (creditCents > 0) {
        await returnUnusedFeeCredit(supabase, { bookingId: opts.bookingId, paymentId: payment.id });
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
        return {
          ok: false,
          error: 'BOOKING_CHANGED',
          message: 'This payment was already being released. Refresh to see the outcome.',
          status: 409,
        };
      }
      const capturedPi = await stripe.paymentIntents.capture(payment.payment_intent_id);
      const settled = reconcileToStripe(capturedPi, fullAuthCents, fullFee, earnerAmountCents);
      if (settled.corrected) {
        await logServerError(FN,
          `capture on ${payment.payment_intent_id}: authorized ${fullAuthCents}, Stripe ` +
          `collected ${settled.receivedCents}. Split re-derived from amount_received.`,
          { booking_id: opts.bookingId, payment_id: payment.id }, { fatal: false });
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

  // ── The retry after this function died mid-flight ──────────────────────────
  //
  // Everything below the Stripe call — settle_booking_benefits, the disputes row, the
  // unused fee credit — runs AFTER the money has irreversibly moved, and up to eight
  // awaited round trips sit in that window (the capture, an optional error log, the
  // payments update, two fee RPCs, return_unused_fee_credit, credit_earnings, the
  // dispute lookup). Lose the instance in there — an SDK read timeout on the capture
  // response, an edge deploy, an eviction — and the capture landed while none of the
  // bookkeeping did. This function's own `.update({ status: 'captured' })` (or, if it
  // died before that, payment_intent.succeeded) leaves the row settled, and the webhook
  // writes NO disputes row, calls NO settle_booking_benefits and returns NO credit.
  //
  // The poster's retry then arrived on an already-'captured' row, skipped the block
  // above, left capturedGigCents null and returned success. So a 50% payout kept no
  // dispute record anywhere — the /disputes queue, ctl_dispute_open_beyond_sla and
  // earner-claim-payment's DISPUTE_OPEN gate all read that table — and the earner's
  // unused referral credit was destroyed with nothing looking in that direction.
  //
  // Re-derive the fact from the LEDGER, never from the caller. `pct` is only what THIS
  // request asks for; `earner_amount_cents + fee_cents` is what was actually collected,
  // and it is short of the immutable `amount_cents` exactly when a partial capture
  // happened. That preserves the anti-fabrication property the dispute gate below was
  // added for: a poster POSTing {pct: 0.5} at a FULLY settled booking still records
  // nothing, because the row says the whole amount was taken.
  //
  // Safe to run on every already-captured retry: settle_booking_benefits is a no-op
  // once settled_at is set, and return_unused_fee_credit is idempotent on the delivered
  // figure. It also repairs the same loss on a FULL capture that aborted before its
  // settle call.
  if (capturedGigCents === null && payment.status === 'captured') {
    const settledTotal = (payment.earner_amount_cents ?? 0) + (payment.fee_cents ?? 0);
    const authorizedTotal = payment.amount_cents || 0;
    if (settledTotal > 0 && authorizedTotal > 0) {
      const observedPct = Math.min(1, settledTotal / authorizedTotal);
      settledPct = observedPct;
      // The gig value this settlement really landed at, scaling the discount the same
      // way the partial branch does so the promo budget is charged one figure.
      capturedGigCents = settledTotal + Math.round(discountCents * observedPct);

      if (creditCents > 0 && settledTotal < authorizedTotal) {
        await returnUnusedFeeCredit(supabase, { bookingId: opts.bookingId, paymentId: payment.id });
      }
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
      p_booking: opts.bookingId,
      p_amount_cents: capturedGigCents,
    });
    if (settleErr) {
      await logServerError(FN,
        `benefit settle failed for booking ${opts.bookingId}: ${settleErr.message}`,
        { booking_id: opts.bookingId, payment_id: payment.id });
    }
  }

  return { ok: true, settledPct, capturedGigCents, earnerAmountCents };
}
