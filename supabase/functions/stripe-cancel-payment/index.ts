// Cancels a PaymentIntent when a booking is declined or cancelled, releasing the card hold.
import Stripe from 'npm:stripe@22.5.0';
import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { one } from '../_shared/pgrest.ts';
import { logServerError, errMessage } from '../_shared/logError.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Carried outside the try so the terminal catch can name WHICH hold failed to
  // release. Every other money function does the same (accept-booking's
  // errBookingId/errUserId); without it the sink row says only "it threw".
  let errBookingId: string | null = null;
  let errUserId: string | null = null;
  let errIntentId: string | null = null;

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);
    errUserId = user.id;

    const { bookingId } = await req.json();
    if (!bookingId) return json({ error: 'bookingId required' }, 400);
    errBookingId = typeof bookingId === 'string' ? bookingId : null;

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
    errIntentId = payment.payment_intent_id ?? null;

    if (payment.status === 'cancelled') {
      return json({ success: true, alreadyCancelled: true });
    }

    // Can't cancel a captured payment — would need a refund instead
    if (payment.status === 'captured') {
      return json({ error: 'Payment already captured; issue a refund instead.' }, 400);
    }

    // Ask Stripe to void the hold. `payment_intent_unexpected_state` means the intent
    // is no longer cancellable, and there are TWO very different reasons for that:
    //
    //   * It is already void — Stripe expired the 7-day authorization, delete-account
    //     cancelled it, or a concurrent decline/cancel got there first. The goal state
    //     is "no hold", so that IS success; throwing here left the row reading
    //     'authorized' against a dead intent until the webhook eventually landed, and
    //     both clients swallow this function's errors (JobsContext.declineBooking
    //     ignores outright, cancelBooking retries once and ignores), so nothing else
    //     would have retried it.
    //   * It already SUCCEEDED — a capture won the race with our read. Stamping the row
    //     'cancelled' there would tell every tool in the console that the poster was
    //     never charged when they were. admin-payment-action's release_hold draws the
    //     same distinction for the same reason, so probe before concluding.
    //
    // Unlike the console path this does NOT rewrite the row to 'captured': that
    // correction belongs to stripe-webhook and reconcile-stripe, which have the amounts.
    // It logs the disagreement and refuses.
    let alreadyVoid = false;
    try {
      await stripe.paymentIntents.cancel(payment.payment_intent_id);
    } catch (e: any) {
      if (e?.code !== 'payment_intent_unexpected_state') throw e;
      const pi = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
      if (pi.status === 'succeeded' || (pi.amount_received ?? 0) > 0) {
        await logServerError('stripe-cancel-payment',
          'Refused to void a hold that Stripe has already CAPTURED — the poster has been '
          + 'charged while our row still reads authorized; this needs a refund, not a release.',
          {
            booking_id: bookingId,
            booking_status: booking.status,
            payment_id: payment.id,
            payment_intent_id: payment.payment_intent_id,
            payment_status: payment.status,
            stripe_status: pi.status,
            stripe_amount_received: pi.amount_received ?? 0,
          },
          { fatal: true, userId: user.id });
        return json({ error: 'Payment already captured; issue a refund instead.' }, 400);
      }
      // Genuinely already void. Not fatal — no money is at risk — but record it, because
      // a hold that keeps arriving here pre-voided means something upstream is releasing
      // holds we never hear about.
      alreadyVoid = true;
      await logServerError('stripe-cancel-payment',
        'Hold was already void at Stripe; reconciling the ledger row instead of failing.',
        {
          booking_id: bookingId,
          booking_status: booking.status,
          payment_id: payment.id,
          payment_intent_id: payment.payment_intent_id,
          payment_status: payment.status,
          stripe_status: pi.status,
        },
        { fatal: false, userId: user.id });
    }

    const { error: updErr } = await supabase.from('payments').update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    }).eq('id', payment.id);
    if (updErr) {
      // The hold is gone at Stripe but the ledger still says 'authorized'. Nothing here
      // retries, so ctl_money_exposed_on_dead_booking would raise it six hours later as
      // 'hold_never_released' with no cause attached. Name the cause now.
      await logServerError('stripe-cancel-payment',
        `ledger_desync: the hold was released at Stripe but the payments row still reads `
        + `'${payment.status}': ${updErr.message}`,
        {
          booking_id: bookingId,
          booking_status: booking.status,
          payment_id: payment.id,
          payment_intent_id: payment.payment_intent_id,
          payment_status: payment.status,
          already_void_at_stripe: alreadyVoid,
        },
        { fatal: true, userId: user.id });
      return json({
        error: 'ledger_desync',
        message: 'The hold was released but the ledger update failed. This is logged.',
      }, 500);
    }

    return json({ success: true, alreadyVoid: alreadyVoid || undefined });
  } catch (err: any) {
    console.error('stripe-cancel-payment:', err);
    // Land it where an operator will actually see it (/errors). This used to stop at
    // console.error, and both clients swallow the 500 — so a failed hold release left
    // the poster's money tied up on a dead booking with no trace of WHY anywhere.
    await logServerError('stripe-cancel-payment',
      `Hold release failed — the poster's money may still be held on a dead booking: ${errMessage(err)}`,
      {
        booking_id: errBookingId,
        payment_intent_id: errIntentId,
        stripe_error_code: err?.code ?? null,
        stripe_error_type: err?.type ?? null,
      },
      { fatal: true, userId: errUserId });
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
