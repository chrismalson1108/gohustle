// Creates a Stripe PaymentIntent (manual capture = escrow) when a poster accepts a booking.
// Charged to poster immediately on card auth; captured to earner after job verification.
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

    // Auth
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const { bookingId } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    // Fetch booking + job + earner
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select(`
        id, job_id, earner_id, counter_offer, status,
        job:jobs!bookings_job_id_fkey(id, title, pay, pay_type, estimated_hours, poster_id),
        earner:profiles!bookings_earner_id_fkey(id, name)
      `)
      .eq('id', bookingId)
      .single();

    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (booking.job.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // A card hold is only created while accepting — reject settled/closed bookings
    // so a poster can't place a fresh hold on an already-finished or cancelled gig.
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return json({ error: 'This booking can no longer take a payment hold.' }, 409);
    }
    // Never destructively overwrite a payment that's already past the authorized
    // stage (captured/cancelled/refunded) — that would orphan a settled record.
    const { data: existingPay } = await supabase
      .from('payments').select('status, amount_cents, payment_intent_id').eq('booking_id', bookingId).maybeSingle();
    if (existingPay && !['authorized', 'failed'].includes(existingPay.status)) {
      return json({ error: 'This booking already has a settled payment.' }, 409);
    }

    // Earner must have a Connect account
    const { data: earnerAcct } = await supabase
      .from('stripe_accounts')
      .select('account_id, onboarded')
      .eq('user_id', booking.earner_id)
      .single();

    // Self-heal: the cached onboarded flag is normally set by the account.updated
    // webhook, but for connected accounts that needs a Connect-scoped webhook and may
    // never fire — leaving onboarded stuck at false. If it's false, verify LIVE before
    // blocking the booking (and sync the cache so later reads are correct).
    let earnerOnboarded = !!earnerAcct?.onboarded;
    if (!earnerOnboarded && earnerAcct?.account_id) {
      try {
        const acc = await stripe.accounts.retrieve(earnerAcct.account_id);
        earnerOnboarded = !!(acc.details_submitted && acc.charges_enabled && acc.payouts_enabled);
        if (earnerOnboarded) {
          await supabase.from('stripe_accounts').update({ onboarded: true }).eq('account_id', earnerAcct.account_id);
        }
      } catch (_) { /* fall through to the not-onboarded response */ }
    }
    if (!earnerOnboarded) {
      return json({ error: 'EARNER_NO_PAYOUT', message: "The earner hasn't set up their payout account yet." }, 400);
    }

    // Amount — use counter_offer if set, else listed pay; multiply for hourly
    const rate = booking.counter_offer ? Number(booking.counter_offer) : Number(booking.job.pay);
    const hours = booking.job.pay_type === 'hourly' ? Number(booking.job.estimated_hours) : 1;
    const amountCents = Math.round(rate * hours * 100);
    // Sanity-bound the amount — counter_offer is earner-controlled, so reject a
    // non-positive or absurd value (cap $10,000) before it reaches Stripe.
    if (!Number.isFinite(amountCents) || amountCents < 50 || amountCents > 1_000_000) {
      return json({ error: 'Invalid booking amount' }, 400);
    }
    const feeCents = Math.round(amountCents * 0.10);         // 10% GoHustlr fee
    const earnerAmountCents = amountCents - feeCents;

    // Get/create Stripe Customer for poster (enables saved cards)
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

    // If a prior hold exists at a DIFFERENT amount (e.g. the poster edited pay then
    // re-accepted), cancel it first. The new intent has a different idempotency key,
    // so the old authorization would otherwise be orphaned on the poster's card until
    // Stripe auto-expires it (~7 days), and the single payments row would point only
    // at the new intent. A same-amount retry keeps the same idempotency key below, so
    // it reuses the existing intent and this cancel is skipped.
    if (existingPay?.payment_intent_id && existingPay.status === 'authorized'
        && (existingPay.amount_cents ?? 0) !== amountCents) {
      try { await stripe.paymentIntents.cancel(existingPay.payment_intent_id); }
      catch (_) { /* already captured / cancelled / expired — ignore */ }
    }

    // PaymentIntent with manual capture (funds held, not charged until capture).
    // Idempotency key (booking + amount) makes a transport retry return the SAME
    // intent instead of creating a second, orphaned authorization hold.
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      capture_method: 'manual',
      application_fee_amount: feeCents,
      transfer_data: { destination: earnerAcct.account_id },
      description: `GoHustlr: ${booking.job.title}`,
      metadata: {
        booking_id: bookingId,
        job_id: booking.job_id,
        earner_id: booking.earner_id,
        poster_id: user.id,
      },
    }, { idempotencyKey: `pi_create_${bookingId}_${amountCents}` });

    // Record in payments table (upsert in case of retry)
    await supabase.from('payments').upsert({
      booking_id: bookingId,
      payment_intent_id: pi.id,
      amount_cents: amountCents,
      fee_cents: feeCents,
      earner_amount_cents: earnerAmountCents,
      status: 'authorized',
    }, { onConflict: 'booking_id' });

    return json({
      clientSecret: pi.client_secret,
      customerId,
      ephemeralKey: ephemeralKey.secret,
      amountCents,
      earnerAmountCents,
      feeCents,
    });
  } catch (err: any) {
    console.error('stripe-create-payment-intent:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
