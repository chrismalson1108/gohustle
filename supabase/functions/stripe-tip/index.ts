// Charges the poster's saved card off-session for a tip and routes it (in full)
// to the earner's Connect account. Called after a job is verified.
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

    const { bookingId, tipCents } = await req.json();
    if (!bookingId || !tipCents || tipCents < 50) return json({ error: 'A valid tip amount is required' }, 400);

    // Verify the caller is the poster of this booking
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, earner_id, job:jobs!bookings_job_id_fkey(title, poster_id)')
      .eq('id', bookingId)
      .single();
    if (!booking) return json({ error: 'Booking not found' }, 404);
    if (booking.job.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // Earner Connect account
    const { data: earnerAcct } = await supabase
      .from('stripe_accounts').select('account_id, onboarded').eq('user_id', booking.earner_id).single();
    if (!earnerAcct?.onboarded) return json({ error: 'Earner has no payout account' }, 400);

    // Poster customer + saved card
    const { data: cust } = await supabase
      .from('stripe_customers').select('customer_id').eq('user_id', user.id).single();
    if (!cust) return json({ error: 'No saved payment method' }, 400);
    const methods = await stripe.paymentMethods.list({ customer: cust.customer_id, type: 'card', limit: 1 });
    const pm = methods.data[0];
    if (!pm) return json({ error: 'No saved card on file' }, 400);

    // Off-session charge → full tip to earner (no platform fee on tips)
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(tipCents),
      currency: 'usd',
      customer: cust.customer_id,
      payment_method: pm.id,
      off_session: true,
      confirm: true,
      transfer_data: { destination: earnerAcct.account_id },
      description: `GoHustlr tip: ${booking.job.title}`,
      metadata: { booking_id: bookingId, type: 'tip', earner_id: booking.earner_id, poster_id: user.id },
    });

    if (pi.status !== 'succeeded') return json({ error: `Tip not completed (${pi.status})` }, 400);

    await supabase.from('bookings').update({ tip_amount: Math.round(tipCents) / 100 }).eq('id', bookingId);

    return json({ success: true, tipCents: Math.round(tipCents) });
  } catch (err: any) {
    console.error('stripe-tip:', err);
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
