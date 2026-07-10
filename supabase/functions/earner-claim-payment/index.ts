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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// MUST match EARNER_CLAIM_GRACE_DAYS in shared/lifecycle.js.
const GRACE_DAYS = 3;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { bookingId } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, earner_done, starts_at, job:jobs!bookings_job_id_fkey(poster_id)')
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

    // Ghosting gate: the scheduled time must be > GRACE_DAYS in the past. (Bookings
    // with no scheduled slot can't be auto-claimed — route those to support.)
    if (!booking.starts_at) {
      return json({ error: 'NO_SCHEDULE', message: 'This booking has no scheduled time — contact support to settle it.' }, 409);
    }
    const eligibleAt = new Date(new Date(booking.starts_at).getTime() + GRACE_MS);
    if (Date.now() < eligibleAt.getTime()) {
      return json({
        error: 'TOO_EARLY',
        message: `You can claim payment ${GRACE_DAYS} days after the scheduled time if the poster hasn't confirmed.`,
      }, 409);
    }

    // Never settle over an active dispute or an unresolved safety/moderation report.
    const { data: dispute } = await supabase
      .from('disputes').select('id').eq('booking_id', bookingId).maybeSingle();
    if (dispute) return json({ error: 'DISPUTE_OPEN', message: 'This booking has an open dispute and can\'t be auto-settled.' }, 409);
    const { data: openReport } = await supabase
      .from('reports').select('id').eq('booking_id', bookingId).is('resolved_at', null).maybeSingle();
    if (openReport) return json({ error: 'UNDER_REVIEW', message: 'This booking is under review and can\'t be auto-settled yet.' }, 409);

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited')
      .eq('booking_id', bookingId)
      .single();
    if (pErr || !payment) return json({ error: 'NO_PAYMENT', message: 'No escrow hold found for this booking.' }, 404);
    if (payment.status === 'cancelled' || payment.status === 'failed') {
      return json({ error: 'HOLD_EXPIRED', message: 'The card hold already expired. Contact the poster or support to re-place a hold.' }, 409);
    }

    // The earner's payout account must still be live (mirrors stripe-capture-payment).
    if (payment.status !== 'captured') {
      const { data: earnerAcct } = await supabase
        .from('stripe_accounts').select('onboarded').eq('user_id', booking.earner_id).single();
      if (!earnerAcct?.onboarded) {
        return json({ error: 'EARNER_PAYOUTS_DISABLED', message: 'Your payout account is not active. Re-verify it, then claim again.' }, 409);
      }
    }

    // Advance a ghosted booking to 'completed' (service role bypasses the write guard).
    if (booking.status !== 'completed') {
      await supabase.from('bookings').update({
        poster_done: true,
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', bookingId);
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
    const settled = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
    const capturedCents = settled.amount_received ?? 0;
    if (capturedCents <= 0) {
      return json({ error: 'CAPTURE_FAILED', message: 'Could not release the payment. Please try again.' }, 502);
    }
    // 10% platform fee on the amount ACTUALLY captured — proportional, matching
    // stripe-capture-payment's partial-fee basis (round(fullFee * pct)). For a full
    // capture this equals round(amount_cents * 0.10); for a poster's partial it tracks
    // the reduced amount, so the ledger is exact and still never > captured.
    const feeCents = Math.round(capturedCents * 0.10);
    await supabase.from('payments').update({
      status: 'captured',
      captured_at: new Date().toISOString(),
      earner_amount_cents: capturedCents - feeCents,
      fee_cents: feeCents,
    }).eq('id', payment.id);

    // Credit the earner exactly once (single conditional UPDATE inside the RPC).
    await supabase.rpc('credit_earnings', { p_payment_id: payment.id });

    // Close the lifecycle: settled without a poster rating (none was given).
    await supabase.from('bookings').update({ status: 'verified' }).eq('id', bookingId);

    return json({ success: true });
  } catch (err) {
    console.error('earner-claim-payment:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
