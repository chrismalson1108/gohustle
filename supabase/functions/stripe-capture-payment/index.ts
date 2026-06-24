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
      .select('id, status, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (booking.job?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'Booking is not ready to capture' }, 409);
    }

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status, amount_cents, fee_cents')
      .eq('booking_id', bookingId)
      .single();

    if (pErr || !payment) return json({ error: 'Payment not found' }, 404);

    // Idempotent — already captured is a success
    if (payment.status === 'captured') {
      return json({ success: true, alreadyCaptured: true });
    }

    const capturePct = (typeof pct === 'number' && pct > 0 && pct < 1) ? pct : 1;

    if (capturePct < 1) {
      const captureCents = Math.max(1, Math.round((payment.amount_cents || 0) * capturePct));
      const feeCents = Math.min(captureCents, Math.round((payment.fee_cents || 0) * capturePct));
      await stripe.paymentIntents.capture(payment.payment_intent_id, {
        amount_to_capture: captureCents,
        application_fee_amount: feeCents,
      });
      await supabase.from('payments').update({
        status: 'captured',
        captured_at: new Date().toISOString(),
        amount_cents: captureCents,
        fee_cents: feeCents,
        earner_amount_cents: captureCents - feeCents,
      }).eq('id', payment.id);
    } else {
      await stripe.paymentIntents.capture(payment.payment_intent_id);
      await supabase.from('payments').update({
        status: 'captured',
        captured_at: new Date().toISOString(),
      }).eq('id', payment.id);
    }

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-capture-payment:', err);
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
