// Detaches (removes) the poster's saved card(s) from their Stripe Customer.
// Used by the "Remove card" action in the Payments hub.
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

    // Optional: keep one card (the one just added in a "replace" flow) and detach the
    // rest, so "Replace card" doesn't leave the previous card orphaned on the customer.
    // Omitted → detach every card ("Remove card").
    const { exceptPaymentMethodId } = await req.json().catch(() => ({}));

    const { data: cust } = await supabase
      .from('stripe_customers')
      .select('customer_id')
      .eq('user_id', user.id)
      .single();

    if (!cust) return json({ success: true, removed: 0 });

    const methods = await stripe.paymentMethods.list({ customer: cust.customer_id, type: 'card' });
    let removed = 0;
    for (const pm of methods.data) {
      if (exceptPaymentMethodId && pm.id === exceptPaymentMethodId) continue;
      await stripe.paymentMethods.detach(pm.id);
      removed++;
    }

    return json({ success: true, removed });
  } catch (err: any) {
    console.error('stripe-detach-payment-method:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
