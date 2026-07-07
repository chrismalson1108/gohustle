// Creates a Stripe Connect Express account for an earner and returns the onboarding URL.
// Called from PayoutSetupScreen. Idempotent — resumable if onboarding was interrupted.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Production web app. Stripe redirects the user's BROWSER here after onboarding, so
// it must be a host that serves real text/html (Supabase Edge Functions force
// text/plain + nosniff). Web callers pass their own origin; this is the fallback.
// Canonical public domain (exempt from Vercel deployment protection once the domain
// is connected). Web callers pass their own origin, so this only applies to mobile.
const DEFAULT_WEB_BASE = 'https://gohustlr.com';

// Validate the caller-supplied origin against an EXACT-host allowlist so a forged
// origin can't turn the Stripe return into an open redirect. The previous check
// accepted any host ending in '.vercel.app' — an attacker's own free preview
// subdomain passed it and could steer the post-onboarding redirect. Pin the
// canonical production domain instead; anything else (incl. old *.vercel.app
// deploy URLs) falls back to the production web app. Mobile passes no origin and
// always uses the default. Add new deploy hosts here explicitly.
const ALLOWED_WEB_HOSTS = new Set([
  'gohustlr.com',
  'www.gohustlr.com',
]);
function resolveWebBase(origin: unknown): string {
  if (typeof origin === 'string' && origin) {
    try {
      const u = new URL(origin);
      const host = u.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      if ((ALLOWED_WEB_HOSTS.has(host) && u.protocol === 'https:') || isLocal) {
        return u.origin;
      }
    } catch (_) {
      /* malformed origin — fall through to default */
    }
  }
  return DEFAULT_WEB_BASE;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const RETURN_URL = `${resolveWebBase((body as { origin?: unknown }).origin)}/stripe/connect-return`;
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

      // Prefill the individual's name from their profile so the hosted onboarding
      // doesn't re-ask for it. business_type is 'individual' — students don't need a
      // business; Stripe collects personal KYC (required to pay anyone).
      const nameParts = (profile?.name || '').trim().split(/\s+/).filter(Boolean);
      const firstName = nameParts[0];
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        metadata: { supabase_uid: user.id },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        individual: {
          email: user.email,
          ...(firstName && { first_name: firstName }),
          ...(lastName && { last_name: lastName }),
        },
        settings: {
          // Automatic daily payouts: once a payment is captured to the earner's
          // connected account, Stripe pays their bank on its standard rolling
          // schedule. 'manual' (the previous value) required us to create every
          // payout ourselves — and no code ever did, so earnings would have sat
          // in the Stripe balance forever.
          payouts: { schedule: { interval: 'daily' } },
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
    const t = typeof err?.type === 'string' ? err.type : '';
    // A bad/expired/missing API key is an OPERATOR config problem, not something the
    // end user can act on — show a friendly message and keep the real error in logs
    // (never leak the key prefix to users). Surface other Stripe errors (e.g. Connect
    // not enabled) since those ARE actionable.
    if (t === 'StripeAuthenticationError') {
      return json({ error: 'Payments are temporarily unavailable. Please try again later.' }, 503);
    }
    const message = t.startsWith('Stripe')
      ? (err.message || 'Stripe could not create the payout account.')
      : 'Something went wrong. Please try again.';
    return json({ error: message, type: t || null }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
