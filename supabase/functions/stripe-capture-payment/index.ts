// Captures a previously-authorized PaymentIntent after both parties verify job completion.
// Stripe automatically transfers earner_amount to their Connect account on capture.
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

    // Optional pct (0<pct<=1): partial capture for a dispute — releases the
    // remainder of the authorized hold back to the poster.
    const { bookingId, pct } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    // Authorization (IDOR guard): capture releases escrow to the earner, so only
    // the poster who owns this booking's job may trigger it, and only once the
    // work is done. Without this any signed-in user could settle others' bookings.
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (booking.job?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'Booking is not ready to capture' }, 409);
    }

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited')
      .eq('booking_id', bookingId)
      .single();

    if (pErr || !payment) return json({ error: 'Payment not found' }, 404);

    let earnerAmountCents = payment.earner_amount_cents ?? 0;

    // Capture the hold if not already captured (idempotent on retry).
    if (payment.status !== 'captured') {
      const capturePct = (typeof pct === 'number' && pct > 0 && pct < 1) ? pct : 1;
      if (capturePct < 1) {
        const captureCents = Math.max(1, Math.round((payment.amount_cents || 0) * capturePct));
        const feeCents = Math.min(captureCents, Math.round((payment.fee_cents || 0) * capturePct));
        await stripe.paymentIntents.capture(payment.payment_intent_id, {
          amount_to_capture: captureCents,
          application_fee_amount: feeCents,
        });
        earnerAmountCents = captureCents - feeCents;
        // Keep amount_cents as the originally-AUTHORIZED hold (audit record of what
        // the poster agreed to). The actually-captured total is derivable as
        // earner_amount_cents + fee_cents; overwriting amount_cents here would erase
        // the authorized figure and break dispute reconciliation.
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
          fee_cents: feeCents,
          earner_amount_cents: earnerAmountCents,
        }).eq('id', payment.id);
      } else {
        await stripe.paymentIntents.capture(payment.payment_intent_id);
        await supabase.from('payments').update({
          status: 'captured',
          captured_at: new Date().toISOString(),
        }).eq('id', payment.id);
      }
    }

    // Credit the earner's earnings dashboard with the NET payout — exactly ONCE.
    // Guarded by payments.earnings_credited so a retry still applies a credit that
    // failed the first time (even when the capture itself already succeeded), and
    // never double-credits. Service role, so the profiles write-guard exempts it.
    if (!payment.earnings_credited && earnerAmountCents > 0 && booking.earner_id) {
      const dollars = earnerAmountCents / 100;
      const { data: prof } = await supabase
        .from('profiles').select('earnings_today, earnings_week, earnings_total')
        .eq('id', booking.earner_id).single();
      if (prof) {
        const { error: credErr } = await supabase.from('profiles').update({
          earnings_today: Number(prof.earnings_today || 0) + dollars,
          earnings_week:  Number(prof.earnings_week  || 0) + dollars,
          earnings_total: Number(prof.earnings_total || 0) + dollars,
        }).eq('id', booking.earner_id);
        // Only mark credited on success, so a transient failure retries next time.
        if (!credErr) {
          await supabase.from('payments').update({ earnings_credited: true }).eq('id', payment.id);
        }
      }
    }

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-capture-payment:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
