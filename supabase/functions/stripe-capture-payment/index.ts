// Captures a previously-authorized PaymentIntent after both parties verify job completion.
// Stripe automatically transfers earner_amount to their Connect account on capture.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    // Optional pct (partial capture for a dispute) releases the remainder of the
    // hold back to the poster. Policy: a reduced payout is allowed ONLY with a stated
    // reason (recorded below as an audit trail) and is FLOORED at 50% — reaching the
    // verify step requires the poster's own mark-done, so the worker earned at least
    // half; a genuine no-show should be cancelled (full refund), not verified at ~0%.
    // This prevents a poster from capturing completed work at a trivial amount.
    const { bookingId, pct, disputeReason } = await req.json();
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
    if (booking.job?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'Booking is not ready to capture' }, 409);
    }

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited')
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
      if (capturePct < 1) {
        const captureCents = Math.max(1, Math.round((payment.amount_cents || 0) * capturePct));
        const feeCents = Math.min(captureCents, Math.round((payment.fee_cents || 0) * capturePct));
        earnerAmountCents = captureCents - feeCents;
        // Persist the REDUCED net BEFORE capturing. Capturing emits
        // payment_intent.succeeded, and the webhook credits earnings from whatever
        // earner_amount_cents the row holds — if we wrote it AFTER the capture, a
        // fast webhook could read the stale full amount and over-credit the earner.
        // Keep amount_cents as the originally-AUTHORIZED hold (audit record); the
        // captured total is derivable as earner_amount_cents + fee_cents.
        await supabase.from('payments').update({
          fee_cents: feeCents,
          earner_amount_cents: earnerAmountCents,
        }).eq('id', payment.id);
        await stripe.paymentIntents.capture(payment.payment_intent_id, {
          amount_to_capture: captureCents,
          application_fee_amount: feeCents,
        });
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
        }).eq('id', payment.id);
      } else {
        // Recompute the FULL split from the AUTHORIZED amount (amount_cents is never
        // overwritten) and persist it BEFORE capturing — same reason as the partial
        // branch: capture emits payment_intent.succeeded and the webhook credits from
        // whatever earner_amount_cents the row holds, so a prior failed partial
        // attempt's stale reduced value must be corrected before a racing webhook can
        // read it (otherwise the earner is under-credited vs. the full amount paid).
        const fullFee = Math.round((payment.amount_cents || 0) * 0.10);
        earnerAmountCents = (payment.amount_cents || 0) - fullFee;
        await supabase.from('payments').update({
          fee_cents: fullFee,
          earner_amount_cents: earnerAmountCents,
        }).eq('id', payment.id);
        await stripe.paymentIntents.capture(payment.payment_intent_id);
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
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

    // Record the dispute server-side so a reduced payout ALWAYS has an audit trail
    // (the client no longer inserts this). Idempotent per booking so a capture retry
    // doesn't duplicate the row.
    if (capturePctFinal < 1) {
      const { data: existingDispute } = await supabase
        .from('disputes').select('id').eq('booking_id', bookingId).maybeSingle();
      if (!existingDispute) {
        await supabase.from('disputes').insert({
          booking_id: bookingId,
          raised_by: user.id,
          reason: String(disputeReason).trim().slice(0, 500),
          pct_paid: Math.round(capturePctFinal * 100),
        });
      }
    }

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-capture-payment:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
