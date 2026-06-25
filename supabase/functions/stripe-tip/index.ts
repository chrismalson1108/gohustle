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
    // Bound the tip (50¢–$1000) — it charges the poster's card off-session.
    if (!bookingId || !tipCents || tipCents < 50 || tipCents > 100_000) {
      return json({ error: 'A valid tip amount (50¢–$1000) is required' }, 400);
    }

    // Verify the caller is the poster of this booking
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(title, poster_id)')
      .eq('id', bookingId)
      .single();
    if (!booking) return json({ error: 'Booking not found' }, 404);
    if (booking.job.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    // Tips are only for finished work — gate to completed/verified bookings.
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'You can tip once the job is complete.' }, 409);
    }

    // Earner Connect account
    const { data: earnerAcct } = await supabase
      .from('stripe_accounts').select('account_id, onboarded').eq('user_id', booking.earner_id).single();
    if (!earnerAcct?.onboarded) return json({ error: 'Earner has no payout account' }, 400);

    // Poster customer + saved card. Prefer the customer's DEFAULT payment method
    // (the card they'd expect to be charged) rather than whatever Stripe lists first.
    const { data: cust } = await supabase
      .from('stripe_customers').select('customer_id').eq('user_id', user.id).single();
    if (!cust) return json({ error: 'No saved payment method' }, 400);
    const customer = await stripe.customers.retrieve(cust.customer_id);
    let pmId: string | null =
      typeof customer !== 'string' && !(customer as any).deleted
        ? ((customer as any).invoice_settings?.default_payment_method ?? null)
        : null;
    if (!pmId) {
      const methods = await stripe.paymentMethods.list({ customer: cust.customer_id, type: 'card', limit: 1 });
      pmId = methods.data[0]?.id ?? null;
    }
    if (!pmId) return json({ error: 'No saved card on file' }, 400);

    // Off-session charge → full tip to earner (no platform fee on tips).
    // Idempotency key (booking + amount) prevents a retried request from charging
    // the poster's saved card twice for the same tip.
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(tipCents),
      currency: 'usd',
      customer: cust.customer_id,
      payment_method: pmId,
      off_session: true,
      confirm: true,
      transfer_data: { destination: earnerAcct.account_id },
      description: `GoHustlr tip: ${booking.job.title}`,
      metadata: { booking_id: bookingId, type: 'tip', earner_id: booking.earner_id, poster_id: user.id },
    }, { idempotencyKey: `tip_${bookingId}_${Math.round(tipCents)}` });

    if (pi.status !== 'succeeded') return json({ error: `Tip not completed (${pi.status})` }, 400);

    const tipDollars = Math.round(tipCents) / 100;

    // Idempotency gate: one ledger row per PaymentIntent. A Stripe idempotent replay
    // (same booking + amount within 24h) returns the SAME pi.id, so the unique index
    // makes the duplicate insert fail — and we then skip the accumulate + credit so a
    // retry can never double-count the tip. Race-safe via unique(payment_intent_id).
    const { error: ledgerErr } = await supabase.from('tip_ledger').insert({
      booking_id: bookingId,
      payment_intent_id: pi.id,
      earner_id: booking.earner_id,
      amount_cents: Math.round(tipCents),
    });
    const alreadyCounted = !!ledgerErr &&
      (String((ledgerErr as any).code) === '23505' ||
        String(ledgerErr.message || '').toLowerCase().includes('duplicate'));
    if (ledgerErr && !alreadyCounted) throw ledgerErr;

    if (!alreadyCounted) {
      // ACCUMULATE the tip onto the booking (a gig may be tipped more than once) —
      // re-read the current value rather than overwriting it.
      const { data: bk } = await supabase
        .from('bookings').select('tip_amount').eq('id', bookingId).single();
      await supabase
        .from('bookings')
        .update({ tip_amount: Number(bk?.tip_amount || 0) + tipDollars })
        .eq('id', bookingId);

      // Tips go in full to the earner — count them in the earner's earnings dashboard
      // (today / week / total), same as captured escrow payouts.
      if (booking.earner_id) {
        const { data: prof } = await supabase
          .from('profiles').select('earnings_today, earnings_week, earnings_total')
          .eq('id', booking.earner_id).single();
        if (prof) {
          await supabase.from('profiles').update({
            earnings_today: Number(prof.earnings_today || 0) + tipDollars,
            earnings_week:  Number(prof.earnings_week  || 0) + tipDollars,
            earnings_total: Number(prof.earnings_total || 0) + tipDollars,
          }).eq('id', booking.earner_id);
        }
      }
    }

    return json({ success: true, tipCents: Math.round(tipCents) });
  } catch (err: any) {
    console.error('stripe-tip:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
