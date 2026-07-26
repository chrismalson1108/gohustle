// Returns (and refreshes) the caller's Stripe Connect payout-account status by
// retrieving the account LIVE from Stripe, then syncing the cached
// stripe_accounts.onboarded flag.
//
// WHY THIS EXISTS: onboarded was previously set to true ONLY by the account.updated
// webhook. But account.updated for a CONNECTED (Express) account is a "Connected
// accounts"-scope event — a platform's normal "Your account" webhook never receives
// it — so the flag could be stuck at false forever. That stuck flag doesn't just
// break the payouts UI; it makes stripe-create-payment-intent / capture / tip reject
// the earner (EARNER_NO_PAYOUT), blocking the whole escrow flow. A live retrieve is
// authoritative and webhook-independent.
//
// It now returns the FULL status (see _shared/connectStatus.ts), not just a boolean,
// so the UI can tell "you skipped a step, go finish it" apart from "Stripe is
// reviewing your ID, just wait" — states that look identical through `onboarded`
// alone but call for opposite user action.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { deriveConnectStatus, NO_ACCOUNT_STATUS } from '../_shared/connectStatus.ts';

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

    if (!acct?.account_id) return json(NO_ACCOUNT_STATUS);

    // Authoritative, live status — no webhook dependency.
    const account = await stripe.accounts.retrieve(acct.account_id);
    const status = deriveConnectStatus(account);

    // Keep the cached flag in sync — it's read by create-payment-intent/capture/tip.
    if (status.onboarded !== acct.onboarded) {
      await supabase
        .from('stripe_accounts')
        .update({ onboarded: status.onboarded })
        .eq('account_id', acct.account_id);
    }

    return json(status);
  } catch (err: any) {
    console.error('stripe-connect-status:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
