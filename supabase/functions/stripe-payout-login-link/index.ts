// Returns a single-use Stripe Express dashboard login link so an onboarded earner
// can manage/update their payout (bank) details inside a browser. Requires the
// connected account to have completed onboarding.
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

    const { data: acct } = await supabase
      .from('stripe_accounts')
      .select('account_id, onboarded')
      .eq('user_id', user.id)
      .single();

    if (!acct?.account_id) return json({ error: 'NO_ACCOUNT', message: 'No payout account yet.' }, 400);
    if (!acct.onboarded)   return json({ error: 'NOT_ONBOARDED', message: 'Finish setting up payouts first.' }, 400);

    const link = await stripe.accounts.createLoginLink(acct.account_id);
    return json({ url: link.url });
  } catch (err: any) {
    console.error('stripe-payout-login-link:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
