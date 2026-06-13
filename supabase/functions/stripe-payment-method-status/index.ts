// Returns whether the current user (poster) has a saved card on file.
// Used to drive the "add a payment method" alerts and to gate booking acceptance.
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

    const { data: cust } = await supabase
      .from('stripe_customers')
      .select('customer_id')
      .eq('user_id', user.id)
      .single();

    if (!cust) return json({ hasPaymentMethod: false });

    const methods = await stripe.paymentMethods.list({
      customer: cust.customer_id,
      type: 'card',
      limit: 1,
    });

    const card = methods.data[0]?.card;
    return json({
      hasPaymentMethod: methods.data.length > 0,
      brand: card?.brand ?? null,
      last4: card?.last4 ?? null,
    });
  } catch (err: any) {
    console.error('stripe-payment-method-status:', err);
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
