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

    const { bookingId } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status')
      .eq('booking_id', bookingId)
      .single();

    if (pErr || !payment) return json({ error: 'Payment not found' }, 404);

    // Idempotent — already captured is a success
    if (payment.status === 'captured') {
      return json({ success: true, alreadyCaptured: true });
    }

    await stripe.paymentIntents.capture(payment.payment_intent_id);

    await supabase.from('payments').update({
      status: 'captured',
      captured_at: new Date().toISOString(),
    }).eq('id', payment.id);

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
