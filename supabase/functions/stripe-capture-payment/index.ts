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

    // Optional pct (0<pct<=1): partial capture for a dispute — releases the
    // remainder of the authorized hold back to the poster.
    const { bookingId, pct } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

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

    let earnerAmountCents = payment.earner_amount_cents ?? 0;

    // Capture the hold if not already captured (idempotent on retry).
    if (payment.status !== 'captured') {
      const capturePct = (typeof pct === 'number' && pct > 0 && pct < 1) ? pct : 1;
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
        await stripe.paymentIntents.capture(payment.payment_intent_id);
        // Recompute the FULL split from the AUTHORIZED amount (amount_cents is never
        // overwritten). A prior failed partial-capture attempt may have left a
        // reduced fee_cents/earner_amount_cents on the row; a full capture transfers
        // the original 10% application fee, so restore the matching full figures —
        // otherwise credit_earnings would credit the stale reduced amount.
        const fullFee = Math.round((payment.amount_cents || 0) * 0.10);
        earnerAmountCents = (payment.amount_cents || 0) - fullFee;
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
          fee_cents: fullFee,
          earner_amount_cents: earnerAmountCents,
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
