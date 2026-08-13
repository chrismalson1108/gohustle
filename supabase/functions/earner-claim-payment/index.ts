// H3 (poster-ghosting-hold-expiry): let an earner who DID the work claim settlement
// of their OWN completed booking when the poster never confirms/verifies — so a
// student who did the work is not left permanently unpaid when the ~7-day Stripe
// authorization hold expires.
//
// This is the earner-initiated counterpart to stripe-capture-payment (which is
// poster-only). It authorizes the EARNER, and only when the poster has genuinely
// ghosted: earner_done = true, the gig's scheduled time is > GRACE_DAYS in the past,
// the booking isn't finalized, there is NO open dispute and NO unresolved report, and
// the earner's payout account is live. It captures the FULL hold (no partial — a
// ghosted poster forfeits the dispute path) and credits exactly once via the same
// credit_earnings RPC. All money movement is initiated by a human (the earner), never
// on a timer.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { logServerError, errMessage } from '../_shared/logError.ts';

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


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// MUST match EARNER_CLAIM_GRACE_DAYS in shared/lifecycle.js.
const GRACE_DAYS = 3;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
// Stripe auto-cancels an uncaptured manual-capture authorization ~7 days after it is
// placed. The claim gate has to know this, because the hold ages from ACCEPT time
// while the grace counts from SLOT time — see the eligibility comment below.
const HOLD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// Unlock the claim this far before the hold dies, so the earner has a real chance to
// act rather than racing Stripe's cancellation to the second.
const HOLD_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Hoisted so the terminal catch can identify the failure. The service client,
  // `user` and `bookingId` are all declared inside the try below and are therefore
  // out of scope there; without these the error row names only the function.
  let errBookingId: string | null = null;
  let errUserId: string | null = null;

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-04-10' });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    errUserId = user?.id ?? null;
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { bookingId } = await req.json();
    errBookingId = typeof bookingId === 'string' ? bookingId : null;
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, earner_done, slot_id, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);

    // Authorization: only the booking's earner may claim, and only for work they
    // actually did + marked done.
    if (booking.earner_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!booking.earner_done) {
      return json({ error: 'NOT_MARKED_DONE', message: 'Mark the job as done first.' }, 409);
    }
    if (['verified', 'declined', 'cancelled'].includes(booking.status)) {
      return json({ error: 'NOT_CLAIMABLE', message: 'This booking is already finalized.' }, 409);
    }

    // Ghosting gate: the scheduled time must be > GRACE_DAYS in the past. Derive it
    // from the POSTER-OWNED job_slots row (via booking.slot_id) — NEVER from
    // bookings.starts_at, which the earner can PATCH on their own booking row and
    // thereby fast-forward this gate to drain the hold for a future gig never
    // performed. (Bookings with no scheduled slot can't be auto-claimed — route those
    // to support.)
    if (!booking.slot_id) {
      return json({ error: 'NO_SCHEDULE', message: 'This booking has no scheduled time — contact support to settle it.' }, 409);
    }
    const { data: slot } = await supabase
      .from('job_slots').select('starts_at').eq('id', booking.slot_id).single();
    if (!slot?.starts_at) {
      return json({ error: 'NO_SCHEDULE', message: 'This booking has no scheduled time — contact support to settle it.' }, 409);
    }
    // When the escrow hold was placed. Needed by the eligibility gate below (the hold
    // ages from ACCEPT time, the grace counts from SLOT time). The full payments row
    // is re-read further down for the capture itself; this is just the timestamp.
    const { data: holdRow } = await supabase
      .from('payments').select('created_at').eq('booking_id', bookingId).maybeSingle();
    const payment_created_at_hint = holdRow?.created_at
      ? new Date(holdRow.created_at).getTime()
      : null;
    // The slot-time grace is the NORMAL anchor, but it cannot be the only one.
    // Stripe auto-cancels an uncaptured authorization ~7 days after it is placed, and
    // the hold is placed at ACCEPT time while this gate counts from SLOT time — so for
    // a gig scheduled well after acceptance the two windows never overlap:
    //
    //   slot 1-3 days out : hold dies day 7, claim opens day 4-6  -> window exists
    //   slot 4 days out   : hold dies day 7, claim opens day 7    -> NO window
    //   slot 5+ days out  : hold dies day 7, claim opens day 8+   -> NO window
    //
    // i.e. every gig booked 4+ days ahead had no self-service payout path at all: the
    // earner does the work, the poster ghosts, and the hold silently expires before
    // the claim ever unlocks. Booking a week or two ahead is completely ordinary.
    //
    // Second anchor: once the scheduled time has actually PASSED (so the work was
    // due) and the hold is within HOLD_EXPIRY_MARGIN_MS of dying, the claim unlocks
    // early. Both conditions are required — "hold is about to expire" alone would let
    // an earner drain the hold for a gig that has not happened yet.
    //
    // RESIDUAL, deliberately not papered over: for a slot 7+ days after acceptance the
    // hold is already dead by the time the work is due, so there is nothing left to
    // capture and no gate change can conjure it. That needs the hold to be placed (or
    // re-authorized) closer to the gig — a payments-architecture change, not a patch.
    // Those bookings fall through to the HOLD_EXPIRED branch below, which is at least
    // explicit and routes to support.
    const slotStart = new Date(slot.starts_at).getTime();
    const eligibleAt = new Date(slotStart + GRACE_MS);
    const holdPlacedAt = payment_created_at_hint;
    const holdNearlyExpired =
      holdPlacedAt !== null &&
      Date.now() >= holdPlacedAt + (HOLD_LIFETIME_MS - HOLD_EXPIRY_MARGIN_MS);
    const scheduledTimePassed = Date.now() >= slotStart;
    const claimUnlocked =
      Date.now() >= eligibleAt.getTime() || (scheduledTimePassed && holdNearlyExpired);
    if (!claimUnlocked) {
      return json({
        error: 'TOO_EARLY',
        message: `You can claim payment ${GRACE_DAYS} days after the scheduled time if the poster hasn't confirmed.`,
      }, 409);
    }

    // Never settle over an active dispute or an unresolved safety/moderation report.
    // Use fail-CLOSED count queries: a single-row .maybeSingle() ERRORS when 2+ rows
    // match (e.g. an earner files junk reports on their own booking to force the
    // multi-row error and slip past a genuine open report), and that error was
    // previously swallowed so the gate failed OPEN. Block when the count is > 0 OR the
    // query errored at all.
    // `resolved_at is null` is load-bearing. Without it ANY dispute row — including
    // one an admin has already investigated and closed — blocked settlement forever,
    // so the disputes table had no lifecycle and this gate could never reopen. That
    // withheld a worker's pay permanently, by construction. Still fail-CLOSED: a
    // count query, blocking on >0 OR on any error.
    const { count: disputeCount, error: disputeErr } = await supabase
      .from('disputes').select('id', { count: 'exact', head: true })
      .eq('booking_id', bookingId).is('resolved_at', null);
    if (disputeErr || (disputeCount ?? 1) > 0) {
      return json({ error: 'DISPUTE_OPEN', message: 'This booking has an open dispute and can\'t be auto-settled.' }, 409);
    }
    // Count ONLY genuine user safety reports/disputes — EXCLUDE source='auto' rows.
    // Auto-moderation files content-scan flags (reports lockdown migration
    // 20260715010000) as source='auto'; a content-moderation flag must NOT permanently
    // block a legitimate ghosting PAYOUT for work actually performed. Still fail-CLOSED
    // on query error and still block on any real user report.
    const { count: reportCount, error: reportErr } = await supabase
      .from('reports').select('id', { count: 'exact', head: true }).eq('booking_id', bookingId).neq('source', 'auto').is('resolved_at', null);
    if (reportErr || (reportCount ?? 1) > 0) {
      return json({ error: 'UNDER_REVIEW', message: 'This booking is under review and can\'t be auto-settled yet.' }, 409);
    }

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited, created_at, fee_bps, fee_credit_cents, poster_discount_cents')
      .eq('booking_id', bookingId)
      .single();
    if (pErr || !payment) return json({ error: 'NO_PAYMENT', message: 'No escrow hold found for this booking.' }, 404);
    if (payment.status === 'cancelled' || payment.status === 'failed') {
      return json({ error: 'HOLD_EXPIRED', message: 'The card hold already expired. Contact the poster or support to re-place a hold.' }, 409);
    }
    // Belt-and-suspenders: the escrow authorization ITSELF must have aged past the
    // grace window. Even if the scheduled time somehow reads as past, a hold placed
    // moments ago can never be instantly claimed.
    if (!payment.created_at || Date.now() < new Date(payment.created_at).getTime() + GRACE_MS) {
      return json({
        error: 'TOO_EARLY',
        message: `You can claim payment ${GRACE_DAYS} days after the scheduled time if the poster hasn't confirmed.`,
      }, 409);
    }

    // The earner's payout account must still be live (mirrors stripe-capture-payment).
    if (payment.status !== 'captured') {
      const { data: earnerAcct } = await supabase
        .from('stripe_accounts').select('onboarded').eq('user_id', booking.earner_id).single();
      if (!earnerAcct?.onboarded) {
        return json({ error: 'EARNER_PAYOUTS_DISABLED', message: 'Your payout account is not active. Re-verify it, then claim again.' }, 409);
      }
    }

    // Capture the FULL hold if Stripe still shows it uncaptured, then settle from
    // Stripe's ACTUAL captured amount. STRIPE is the sole source of truth for the
    // amount — we NEVER pre-write a computed amount to the payments row. The poster's
    // stripe-capture-payment can run a PARTIAL (dispute) capture concurrently in the
    // ghosting window; if we wrote the full split before crediting, a racing credit
    // (webhook / the poster's own credit_earnings) could read that inflated value and
    // over-credit the earner vs. what was collected — a platform loss. Reconciling
    // `earner_amount_cents` to `amount_received` right before crediting makes it
    // impossible to credit more than was captured. (Worst residual is a recoverable
    // UNDER-credit if a racing webhook credits from a not-yet-reconciled row.)
    const pi = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
    const capturedOnStripe = pi.status === 'succeeded' || (pi.amount_received ?? 0) > 0;
    if (!capturedOnStripe) {
      try {
        await stripe.paymentIntents.capture(payment.payment_intent_id);
      } catch (_capErr) {
        // Lost a capture race to a concurrent poster capture — reconcile from Stripe below.
      }
    }

    // Reconcile the row to Stripe's ACTUAL captured amount (source of truth) so
    // credit_earnings settles exactly what was collected — never more than captured.
    // expand latest_charge: stripe@15's default API version does not populate
    // `pi.charges` (replaced by latest_charge in 2022-11-15), and the charge is where
    // application_fee_amount lives.
    const settled = await stripe.paymentIntents.retrieve(payment.payment_intent_id, {
      expand: ['latest_charge'],
    });
    const capturedCents = settled.amount_received ?? 0;
    const settledCharge = (settled.latest_charge ?? null) as { application_fee_amount?: number | null } | null;
    const stripeFeeCents = typeof settledCharge?.application_fee_amount === 'number'
      ? settledCharge.application_fee_amount
      : null;
    if (capturedCents <= 0) {
      return json({ error: 'CAPTURE_FAILED', message: 'Could not release the payment. Please try again.' }, 502);
    }
    // Platform fee on the amount ACTUALLY captured — proportional, matching
    // stripe-capture-payment's partial-fee basis. The RATE comes from payments.fee_bps,
    // pinned at authorization (20260806050000), so an earner self-settling weeks later
    // is charged the rate their booking was struck at, not whatever is current.
    // Computed by public.platform_fee_cents so this path cannot drift from the other
    // three — one definition of the fee, everywhere.
    // PREFER THE FEE STRIPE ACTUALLY APPLIED.
    //
    // Recomputing platform_fee_cents(capturedCents, bps) re-applies the WHOLE 30c+25c
    // processing floor to an already-reduced amount, so on a partial capture the ledger
    // records more fee than Stripe took. stripe-capture-payment scales one immutable
    // number instead — min(captureCents, round(fullFee * pct)) — and that is what
    // becomes application_fee_amount. Reading it back is the only way to be certain the
    // two agree, and on a partial capture they otherwise do not: at 500 bps a $20 gig
    // has fee 113c (floor-dominant), a 50% capture takes round(113*0.5)=57c at Stripe,
    // while recomputing from $10 gives the full 84c floor again — a 27c over-collection
    // taken from the earner.
    //
    // The recompute remains the fallback for the self-settle path, where WE performed
    // the capture and no application fee was ever set by anyone else.
    const claimBps = safeBps(payment.fee_bps);
    const { data: claimFee, error: claimFeeErr } = stripeFeeCents !== null
      ? { data: stripeFeeCents, error: null }
      : await supabase.rpc('platform_fee_after_credit', {
          p_amount_cents: capturedCents + Math.max(0, Math.trunc(Number(payment.poster_discount_cents) || 0)),
          p_fee_bps: claimBps,
          p_credit_cents: Math.max(0, Math.trunc(Number(payment.fee_credit_cents) || 0)),
        });
    if (claimFeeErr || !Number.isFinite(Number(claimFee))) {
      // FAIL CLOSED. Stripe has already captured at this point, so we must not write
      // a guessed split — leave the row for remediation and surface it as fatal.
      await logServerError('earner-claim-payment',
        `fee computation failed after capture (bps=${claimBps}, captured=${capturedCents}): ${claimFeeErr?.message ?? 'non-numeric'}`,
        { booking_id: bookingId, payment_id: payment.id }, { fatal: true });
      return json({ error: 'CAPTURE_FAILED', message: 'Payment captured but could not be split. Support has been notified.' }, 500);
    }
    const feeCents = Number(claimFee);
    await supabase.from('payments').update({
      status: 'captured',
      captured_at: new Date().toISOString(),
      earner_amount_cents: capturedCents - feeCents,
      fee_cents: feeCents,
    }).eq('id', payment.id);

    // Credit the earner exactly once (single conditional UPDATE inside the RPC).
    await supabase.rpc('credit_earnings', { p_payment_id: payment.id });

    // Close the lifecycle: settled without a poster rating (none was given). Advance
    // poster_done + completed_at + status to 'verified' ONLY here — after a confirmed
    // non-zero capture and the credit_earnings call — so a failed capture
    // (CAPTURE_FAILED above) can never leave a booking falsely showing
    // 'completed'/poster_done=true with no money moved.
    const finalUpdate: Record<string, unknown> = { status: 'verified', poster_done: true };
    if (booking.status !== 'completed') finalUpdate.completed_at = new Date().toISOString();
    await supabase.from('bookings').update(finalUpdate).eq('id', bookingId);

    return json({ success: true });
  } catch (err) {
    console.error('earner-claim-payment:', err);
    // Land it where an operator will actually see it (/errors in the admin
    // console). This used to stop at console.error, so a money-path failure
    // was invisible unless someone was tailing Supabase function logs.
    await logServerError('earner-claim-payment', `Earner self-settlement failed — worker is unpaid on completed work: ${errMessage(err)}`,
      { booking_id: errBookingId }, { fatal: true, userId: errUserId });
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
