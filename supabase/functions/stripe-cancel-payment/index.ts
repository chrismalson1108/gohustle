// Cancels a PaymentIntent when a booking is declined or cancelled, releasing the card hold.
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

    const { bookingId } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status')
      .eq('booking_id', bookingId)
      .single();

    // No payment record means booking was never paid — nothing to cancel
    if (pErr || !payment) return json({ success: true, noPayment: true });

    if (payment.status === 'cancelled') {
      return json({ success: true, alreadyCancelled: true });
    }

    // Can't cancel a captured payment — would need a refund instead
    if (payment.status === 'captured') {
      return json({ error: 'Payment already captured; issue a refund instead.' }, 400);
    }

    await stripe.paymentIntents.cancel(payment.payment_intent_id);

    await supabase.from('payments').update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    }).eq('id', payment.id);

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-cancel-payment:', err);
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
