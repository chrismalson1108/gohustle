// Creates a Stripe Connect Express account for an earner and returns the onboarding URL.
// Called from PayoutSetupScreen. Idempotent — resumable if onboarding was interrupted.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RETURN_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-connect-return';

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

    // Already fully onboarded
    const { data: existing } = await supabase
      .from('stripe_accounts')
      .select('account_id, onboarded')
      .eq('user_id', user.id)
      .single();

    if (existing?.onboarded) {
      return json({ alreadyOnboarded: true });
    }

    let accountId = existing?.account_id;

    // Create account if not yet created
    if (!accountId) {
      const { data: profile } = await supabase
        .from('profiles').select('name').eq('id', user.id).single();

      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        metadata: { supabase_uid: user.id },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        individual: { email: user.email },
        settings: {
          payouts: { schedule: { interval: 'manual' } }, // we control payout timing
        },
      });

      accountId = account.id;
      await supabase.from('stripe_accounts').insert({
        user_id: user.id,
        account_id: accountId,
        onboarded: false,
      });
    }

    // Generate (or regenerate) onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: RETURN_URL,
      return_url: RETURN_URL,
      type: 'account_onboarding',
    });

    return json({ url: accountLink.url, accountId });
  } catch (err: any) {
    console.error('stripe-connect-onboard:', err);
    // Surface Stripe's own (safe, actionable) message — e.g. "Connect is not enabled
    // on this account" — so the user sees the real reason instead of a silent no-op.
    // Stripe SDK errors carry a descriptive .message and a .type starting "Stripe".
    const isStripe = typeof err?.type === 'string' && err.type.startsWith('Stripe');
    const message = isStripe
      ? (err.message || 'Stripe could not create the payout account.')
      : 'Something went wrong. Please try again.';
    return json({ error: message, type: err?.type ?? null }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
