// Cancels a PaymentIntent when a booking is declined or cancelled, releasing the card hold.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { one } from '../_shared/pgrest.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-04-10' });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { bookingId } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    // Authorization (IDOR guard): releasing a card hold may only be done by the
    // poster (on decline/cancel) or the earner (on withdraw) of this booking.
    // Without this any signed-in user could void others' confirmed holds.
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, started_at, earner_id, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id && booking.earner_id !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }
    // A hold may only be released while the booking is still open. Once work is
    // done (completed/verified) the funds belong to the earner — use a refund.
    if (['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'This booking can no longer be cancelled.' }, 409);
    }
    // ...and the booking must ALREADY be in a state where no work is expected.
    //
    // This function only voids the hold; it never writes to the bookings row. That is
    // fine when it is called as the second half of decline/cancel — declineBooking
    // calls it while the booking is still 'pending', and cancelBooking sets
    // 'cancelled' FIRST and says so ("now it's safe to release the hold"). Both
    // clients, both flows.
    //
    // But it is a plain authenticated endpoint, and nothing forced that pairing. A
    // poster could accept a booking — escrow authorized, earner pushed "Booking
    // accepted!", gig showing as Active — and then call this directly with their own
    // token. Every guard passed: status 'confirmed' is not completed/verified,
    // started_at is null because the earner has not tapped "I'm on site" yet, and the
    // payment is still 'authorized'. The hold is voided, payments reads 'cancelled',
    // and the BOOKING IS UNTOUCHED. Neither client reads the payments table, so the
    // earner is shown a live, accepted gig with nothing behind it. They do the work
    // and there is no money to capture.
    //
    // admin/lib/deleteUser.ts already names this contract — CANCELLABLE_STATUSES,
    // commented "Only holds on un-started bookings may be voided. Mirrors the edge
    // function." The edge function was the one place it was never actually enforced.
    const CANCELLABLE_STATUSES = ['pending', 'declined', 'cancelled'];
    if (!CANCELLABLE_STATUSES.includes(booking.status)) {
      return json({
        error: 'BOOKING_STILL_LIVE',
        message: 'Cancel or decline the booking first — a live booking must keep its hold.',
      }, 409);
    }
    // Once the worker has started ("I'm on site"), the booking is locked the same
    // way the DB trigger trg_guard_started_booking_cancel locks the bookings row.
    // Without this, a client-side race could void the hold on a still-active job.
    if (booking.started_at) {
      return json({ error: 'Work has already started; open a dispute instead.' }, 409);
    }

    const { data: payment, error: pErr } = await supabase
      .from('payments')
      .select('id, payment_intent_id, status')
      .eq('booking_id', bookingId)
      .single();

    // No payment record means booking was never paid — nothing to cancel
    if (pErr || !payment) return json({ success: true, noPayment: true });

    if (payment.status === 'cancelled') {
      return json({ success: true, alreadyCancelled: true });
    }

    // Can't cancel a captured payment — would need a refund instead
    if (payment.status === 'captured') {
      return json({ error: 'Payment already captured; issue a refund instead.' }, 400);
    }

    await stripe.paymentIntents.cancel(payment.payment_intent_id);

    await supabase.from('payments').update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    }).eq('id', payment.id);

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-cancel-payment:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
