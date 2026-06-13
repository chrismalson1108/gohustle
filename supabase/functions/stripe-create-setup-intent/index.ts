// Creates a SetupIntent so a poster can save a card on file BEFORE accepting a booking.
// Mirrors the customer get-or-create logic in stripe-create-payment-intent.
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

    // Get/create Stripe Customer for this poster
    let customerId: string;
    const { data: existingCust } = await supabase
      .from('stripe_customers')
      .select('customer_id')
      .eq('user_id', user.id)
      .single();

    if (existingCust) {
      customerId = existingCust.customer_id;
    } else {
      const { data: profile } = await supabase
        .from('profiles').select('name').eq('id', user.id).single();
      const customer = await stripe.customers.create({
        email: user.email,
        name: profile?.name,
        metadata: { supabase_uid: user.id },
      });
      customerId = customer.id;
      await supabase.from('stripe_customers').insert({ user_id: user.id, customer_id: customerId });
    }

    // Ephemeral key lets the mobile SDK manage saved cards
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' },
    );

    // SetupIntent saves the card for future off-session escrow charges
    const si = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      metadata: { supabase_uid: user.id },
    });

    return json({
      setupIntentClientSecret: si.client_secret,
      customerId,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err: any) {
    console.error('stripe-create-setup-intent:', err);
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
