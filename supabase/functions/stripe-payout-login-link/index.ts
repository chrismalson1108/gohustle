// Returns a single-use Stripe Express dashboard login link so an onboarded earner
// can manage/update their payout (bank) details inside a browser. Requires the
// connected account to have completed onboarding.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { requireStepUp } from '../_shared/stepUp.ts';

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

    // STEP-UP. This link lands the holder inside the Express dashboard, where the
    // bank account can be changed — so it is the single most valuable thing a stolen
    // session can reach. Any valid token used to be enough. See _shared/stepUp.ts for
    // why this is gated on having a factor rather than on having money.
    const step = await requireStepUp(supabase, user.id, token);
    if (!step.ok) return json(step.body!, step.status!);

    const link = await stripe.accounts.createLoginLink(acct.account_id);

    // TRIPWIRE, out of band. Step-up raises the bar; this is what catches someone who
    // clears it anyway (a session stolen after the code was entered, a shared device).
    // Deliberately EMAIL and not an in-app alert: an attacker holding the session can
    // read and dismiss an in-app notification, and email is the one channel they do
    // not already control. Nothing here can fail the request — the user asked for a
    // link and is getting it.
    try {
      const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
      if (RESEND_API_KEY && user.email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: Deno.env.get('NOTIFY_FROM') || 'GoHustlr <notifications@gohustlr.com>',
            to: [user.email],
            subject: 'Your GoHustlr payout settings were opened',
            html: `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#363636;">
              <p>Someone just opened the payout settings for your GoHustlr account, where bank details can be changed.</p>
              <p><strong>If this was you, nothing to do.</strong></p>
              <p>If it was not, change your password immediately and turn on two-factor
                 authentication under Settings → Security. Then check that your bank
                 details are still yours.</p>
              <hr style="border:none;border-top:1px solid #E4DFD3;margin:20px 0;">
              <p style="font-size:12px;color:#9A93AD;">You cannot turn this alert off — it protects your earnings.</p>
            </div>`,
          }),
        });
      }
    } catch (e) {
      console.error('payout-login-link: alert email failed', e);
    }

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
