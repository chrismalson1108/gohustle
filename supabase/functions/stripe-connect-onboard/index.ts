// Creates a Stripe Connect Express account for an earner and returns the onboarding URL.
// Called from PayoutSetupScreen. Idempotent — resumable if onboarding was interrupted.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { deriveConnectStatus } from '../_shared/connectStatus.ts';

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

// Answered on the earner's behalf so hosted onboarding never asks a student for
// their "industry" and "company website". Every earner on the platform does the
// same thing — short-term local gig work as an independent contractor — so this is
// genuinely uniform, not a guess we're papering over.
//   mcc 7299 = Miscellaneous Personal Services, the standard code for errand /
//   task / odd-job labor marketplaces.
//   url points at the platform: earners have no site of their own, and Stripe
//   accepts a marketplace URL plus a product_description for exactly this case.
const BUSINESS_PROFILE = {
  mcc: '7299',
  product_description:
    'Independent contractor performing short-term local gig work (errands, moving help, cleaning, yard work, tutoring and similar tasks) booked through the GoHustlr marketplace.',
  url: 'https://gohustlr.com',
};
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

    const { data: existing } = await supabase
      .from('stripe_accounts')
      .select('account_id, onboarded')
      .eq('user_id', user.id)
      .single();

    // Re-check LIVE before short-circuiting. The cached flag can be stale in BOTH
    // directions: stale-false is handled by stripe-connect-status, but a stale-TRUE
    // (account later restricted, or a requirement newly past_due) would return
    // alreadyOnboarded and leave the user with no way back into onboarding to fix it.
    if (existing?.account_id) {
      // Deliberately non-fatal: the account can be unretrievable (deleted in Stripe, a
      // sandbox reset, a transient API blip). Setting up payouts must not hard-fail on
      // that — fall through and let the account-link step below do its normal thing,
      // exactly as it did before this live re-check existed.
      try {
        const account = await stripe.accounts.retrieve(existing.account_id);
        const status = deriveConnectStatus(account);
        if (status.onboarded !== existing.onboarded) {
          await supabase
            .from('stripe_accounts')
            .update({ onboarded: status.onboarded })
            .eq('account_id', existing.account_id);
        }
        // Genuinely done, or waiting on Stripe's review — either way there is nothing
        // for the user to do in a fresh onboarding session, so don't send them into one.
        if (status.onboarded || status.state === 'pending' || status.state === 'restricted') {
          return json({ alreadyOnboarded: status.onboarded, status });
        }

        // Backfill business_profile on accounts created before we prefilled it.
        // Otherwise those earners stay parked on the "Additional information / Your
        // website" step forever, answering a question we can answer for them.
        // Only fills what's blank — never overwrites something the earner set.
        const bp = account.business_profile;
        if (!bp?.product_description || !bp?.mcc || !bp?.url) {
          await stripe.accounts.update(existing.account_id, {
            business_profile: {
              mcc: bp?.mcc || BUSINESS_PROFILE.mcc,
              product_description: bp?.product_description || BUSINESS_PROFILE.product_description,
              url: bp?.url || BUSINESS_PROFILE.url,
            },
          });
        }
      } catch (e) {
        console.error('stripe-connect-onboard: live account re-check failed:', e);
      }
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
        // Prefilled so hosted onboarding never shows the "Additional information /
        // Your website" step. Without it Stripe has to stop and ask each earner for
        // their industry and company website — a question a student mowing lawns
        // cannot sensibly answer, and it lands in currently_due as "a short
        // description of the work you do", blocking payouts. Stripe accepts a
        // product_description in place of a URL (its own form offers exactly that
        // fallback), so we answer on the earner's behalf. See BUSINESS_PROFILE.
        business_profile: BUSINESS_PROFILE,
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
