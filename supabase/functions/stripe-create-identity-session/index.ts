// Creates a Stripe Identity VerificationSession for the signed-in user and
// returns the hosted verification URL. The app opens that URL; when the user
// finishes, Stripe fires `identity.verification_session.verified` to the
// stripe-webhook function, which flips profiles.verified + id_verification_status.
//
// Resumable: if a session is already pending we re-use its hosted URL rather
// than creating a duplicate.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Production web app — Stripe redirects the user's BROWSER here, so it must serve
// real text/html (Supabase Edge Functions force text/plain + nosniff). Web callers
// pass their own origin; this is the fallback.
// Canonical public domain (exempt from Vercel deployment protection once the domain
// is connected). Web callers pass their own origin, so this only applies to mobile.
const DEFAULT_WEB_BASE = 'https://gohustlr.com';

// Validate the caller-supplied origin against an EXACT-host allowlist so a forged
// origin can't turn the Stripe return into an open redirect. The previous check
// accepted any host ending in '.vercel.app' — an attacker's own free preview
// subdomain passed it and could steer the post-verification redirect. Pin the
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
    const RETURN_URL = `${resolveWebBase((body as { origin?: unknown }).origin)}/stripe/identity-return`;
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { data: profile } = await supabase
      .from('profiles')
      .select('verified, id_verification_status, stripe_identity_session_id')
      .eq('id', user.id)
      .single();

    if (profile?.verified) return json({ alreadyVerified: true });

    // Re-use an in-flight session if it's still usable.
    if (profile?.stripe_identity_session_id) {
      try {
        const existing = await stripe.identity.verificationSessions.retrieve(
          profile.stripe_identity_session_id,
        );
        if (existing.status === 'requires_input' && existing.url) {
          return json({ url: existing.url, sessionId: existing.id });
        }
      } catch (_) {
        // Stale id — fall through and create a fresh session.
      }
    }

    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { supabase_uid: user.id },
      return_url: RETURN_URL,
      options: {
        document: { require_matching_selfie: true },
      },
    });

    await supabase.from('profiles').update({
      id_verification_status: 'pending',
      id_verification_requested_at: new Date().toISOString(),
      stripe_identity_session_id: session.id,
    }).eq('id', user.id);

    return json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error('stripe-create-identity-session:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
