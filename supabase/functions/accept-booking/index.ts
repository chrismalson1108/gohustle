// Confirms a booking — but ONLY after verifying a REAL escrow hold exists.
//
// The poster calls this after authorizing the card client-side. We re-fetch the
// PaymentIntent from Stripe and require status 'requires_capture' (a manual-capture
// PI that has genuinely placed an authorization hold) before flipping the booking to
// 'confirmed'. This is the sole confirm path: guard_bookings_write blocks a client
// from setting status='confirmed' directly, so a poster cannot mark a booking
// confirmed without actually funding the escrow (which would mean free work).
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    // Authorization: only the poster who owns this booking's job may accept it.
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(title, poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (booking.job?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (booking.status === 'confirmed') return json({ ok: true, alreadyConfirmed: true });
    if (booking.status !== 'pending') {
      return json({ error: 'This booking can no longer be accepted.' }, 409);
    }

    // There must be a payment record with a PaymentIntent.
    const { data: payment } = await supabase
      .from('payments').select('id, payment_intent_id').eq('booking_id', bookingId).maybeSingle();
    if (!payment?.payment_intent_id) {
      return json({ error: 'NO_ESCROW', message: 'Start the payment hold before accepting.' }, 409);
    }

    // Source of truth = Stripe. A manual-capture PI with a real authorization hold is
    // 'requires_capture'. Anything else means no funds are actually held.
    const pi = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
    if (pi.status !== 'requires_capture') {
      return json({
        error: 'HOLD_NOT_AUTHORIZED',
        message: 'The card hold is not authorized yet. Please complete the payment step.',
      }, 409);
    }

    // Real hold confirmed → mark the payment authorized (reflecting reality) and
    // confirm the booking. Service role, so guard_bookings_write exempts these writes.
    await supabase.from('payments').update({ status: 'authorized' }).eq('id', payment.id);
    const { error: updErr } = await supabase
      .from('bookings').update({ status: 'confirmed' }).eq('id', bookingId);
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true });
  } catch (err) {
    console.error('accept-booking:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
