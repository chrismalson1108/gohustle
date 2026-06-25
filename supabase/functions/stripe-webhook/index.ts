// Stripe webhook handler — keeps DB in sync with payment events.
// Register this URL in Stripe Dashboard → Developers → Webhooks:
//   https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-webhook
// Required events: payment_intent.succeeded, payment_intent.payment_failed, account.updated,
//   identity.verification_session.verified, identity.verification_session.requires_input,
//   identity.verification_session.canceled
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });

  // Must use raw body string for signature verification
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature error:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        await supabase.from('payments')
          .update({ status: 'captured', captured_at: new Date().toISOString() })
          .eq('payment_intent_id', pi.id);
        // Settlement must credit the earner exactly once, no matter which path
        // (this webhook or the capture edge function) observes it first. The
        // credit_earnings RPC is atomic + idempotent, so calling it here is safe.
        const { data: paid } = await supabase
          .from('payments').select('id').eq('payment_intent_id', pi.id).single();
        if (paid?.id) await supabase.rpc('credit_earnings', { p_payment_id: paid.id });
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        await supabase.from('payments')
          .update({ status: 'failed' })
          .eq('payment_intent_id', pi.id);
        const { data: payment } = await supabase
          .from('payments').select('booking_id').eq('payment_intent_id', pi.id).single();
        if (payment) {
          // Only revert to 'pending' while the booking is still pre-settlement. If
          // the work is already done (completed/verified) this is a CAPTURE failure
          // — don't undo a finished job; leave the status so the poster can retry
          // capture rather than silently resurfacing a completed gig as a request.
          const { data: bk } = await supabase
            .from('bookings').select('status').eq('id', payment.booking_id).single();
          if (bk && ['pending', 'confirmed'].includes(bk.status)) {
            await supabase.from('bookings').update({ status: 'pending' }).eq('id', payment.booking_id);
          }
        }
        break;
      }

      case 'account.updated': {
        // Earner's Connect account capability changed. Track it BOTH ways: if Stripe
        // later restricts/deauthorizes the account (loses charges/payouts), demote
        // onboarded to false so new escrow holds + tips stop targeting an account
        // that can no longer receive funds.
        const account = event.data.object as Stripe.Account;
        const fullyOnboarded = !!(
          account.details_submitted &&
          account.charges_enabled &&
          account.payouts_enabled
        );
        await supabase.from('stripe_accounts')
          .update({ onboarded: fullyOnboarded })
          .eq('account_id', account.id);
        break;
      }

      case 'identity.verification_session.verified': {
        // Stripe confirmed the user's government ID + selfie match.
        const vs = event.data.object as Stripe.Identity.VerificationSession;
        const uid = vs.metadata?.supabase_uid;
        if (uid) {
          await supabase.from('profiles')
            .update({ verified: true, id_verification_status: 'verified' })
            .eq('id', uid);
        }
        break;
      }

      case 'identity.verification_session.requires_input': {
        // Verification could not be completed (e.g. unreadable document).
        const vs = event.data.object as Stripe.Identity.VerificationSession;
        const uid = vs.metadata?.supabase_uid;
        if (uid) {
          await supabase.from('profiles')
            .update({ id_verification_status: 'rejected' })
            .eq('id', uid);
        }
        break;
      }

      case 'identity.verification_session.canceled': {
        // User abandoned the flow — reset so they can try again.
        const vs = event.data.object as Stripe.Identity.VerificationSession;
        const uid = vs.metadata?.supabase_uid;
        if (uid) {
          await supabase.from('profiles')
            .update({ id_verification_status: 'none', stripe_identity_session_id: null })
            .eq('id', uid);
        }
        break;
      }

      default:
        // Unhandled events — no-op
        break;
    }
  } catch (err: any) {
    // Log internals server-side only; never leak exception text to the caller.
    console.error('Webhook handler error:', err);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
