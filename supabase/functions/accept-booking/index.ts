// Confirms a booking — but ONLY after verifying a REAL escrow hold exists.
//
// The poster calls this after authorizing the card client-side. We re-fetch the
// PaymentIntent from Stripe and require status 'requires_capture' (a manual-capture
// PI that has genuinely placed an authorization hold) before flipping the booking to
// 'confirmed'. This is the sole confirm path: guard_bookings_write blocks a client
// from setting status='confirmed' directly, so a poster cannot mark a booking
// confirmed without actually funding the escrow (which would mean free work).
import Stripe from 'npm:stripe@22';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { logServerError, errMessage } from '../_shared/logError.ts';
import { one } from '../_shared/pgrest.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Hoisted so the terminal catch can identify the failure. The service client,
  // `user` and `bookingId` are all declared inside the try below and are therefore
  // out of scope there; without these the error row names only the function.
  let errBookingId: string | null = null;
  let errUserId: string | null = null;

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    errUserId = user?.id ?? null;
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { bookingId } = await req.json();
    errBookingId = typeof bookingId === 'string' ? bookingId : null;
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    // Authorization: only the poster who owns this booking's job may accept it.
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(title, poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (booking.status === 'confirmed') return json({ ok: true, alreadyConfirmed: true });
    if (booking.status !== 'pending') {
      return json({ error: 'This booking can no longer be accepted.' }, 409);
    }

    // There must be a payment record with a PaymentIntent.
    const { data: payment } = await supabase
      .from('payments').select('id, payment_intent_id').eq('booking_id', bookingId).maybeSingle();
    if (!payment?.payment_intent_id) {
      return json({ error: 'NO_ESCROW', message: 'Start the payment hold before accepting.' }, 409);
    }

    // Source of truth = Stripe. A manual-capture PI with a real authorization hold is
    // 'requires_capture'. Anything else means no funds are actually held.
    const pi = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
    if (pi.status !== 'requires_capture') {
      return json({
        error: 'HOLD_NOT_AUTHORIZED',
        message: 'The card hold is not authorized yet. Please complete the payment step.',
      }, 409);
    }

    // Real hold confirmed → mark the payment authorized (reflecting reality) and
    // confirm the booking. Service role, so guard_bookings_write exempts these writes.
    //
    // Predicated for the same reason the booking confirm below is, and it is NOT covered
    // by that guard. Everything above this line is a read, so a release landing between
    // the Stripe retrieve and this write is a live window — and declineBooking calls
    // stripe-cancel-payment BEFORE it writes 'declined' (JobsContext), so for the whole
    // of that window the booking is still 'pending' and the confirm predicate below
    // matches happily. Unpredicated, this stamps 'authorized' over 'cancelled': the row
    // then names a voided PaymentIntent as a live hold, which is what both UIs, every
    // escrow control and stripe-capture-payment read as "money is held".
    //
    // 'failed' is deliberately ALLOWED, and that is load-bearing rather than an
    // oversight. A declined card demotes the row to 'failed' via the payment_failed
    // webhook; the poster then retries on the SAME clientSecret and it is that second
    // attempt which makes the intent requires_capture — precisely the state verified
    // just above. Excluding 'failed' would leave a live hold recorded as failed, and
    // stripe-capture-payment hard-refuses a 'failed' row with HOLD_EXPIRED, stranding
    // the poster permanently on a booking they have genuinely paid for.
    //
    // So exclude only the two that must never be resurrected: 'cancelled' (Stripe has
    // released the funds) and 'captured' (the money already moved).
    const { data: payAuthorized, error: payErr } = await supabase
      .from('payments')
      .update({ status: 'authorized' })
      .eq('id', payment.id)
      .in('status', ['authorized', 'failed'])
      .select('id');
    if (payErr) return json({ error: payErr.message }, 500);
    if (!payAuthorized || payAuthorized.length === 0) {
      // Fail safe: something released or settled this payment underneath us, so do NOT
      // confirm the booking — a confirmed booking with no hold behind it is free work.
      // Re-read for the operator; the status we selected above is stale by definition.
      const { data: current } = await supabase
        .from('payments').select('status').eq('id', payment.id).maybeSingle();
      await logServerError('accept-booking',
        `accept raced a payment state change on booking ${bookingId}: Stripe reported ` +
        `requires_capture but the row is now '${current?.status ?? 'missing'}' — refused to confirm`,
        { booking_id: bookingId, payment_id: payment.id, payment_status: current?.status ?? null },
        { fatal: false, userId: user.id });
      return json({
        error: 'HOLD_RELEASED',
        message: 'The payment on this booking changed while you were accepting it. Refresh and try again.',
      }, 409);
    }
    // Guard the confirm with a status predicate so a booking the earner concurrently
    // withdrew (pending→cancelled) between our earlier read and here isn't silently
    // flipped back to 'confirmed' — that would leave a confirmed booking whose hold
    // the cancel path just released. If 0 rows update, the booking is no longer
    // pending; surface that instead of a false success.
    const { data: updated, error: updErr } = await supabase
      .from('bookings').update({ status: 'confirmed' }).eq('id', bookingId).eq('status', 'pending').select('id');
    if (updErr) return json({ error: updErr.message }, 500);
    if (!updated || updated.length === 0) {
      return json({ error: 'BOOKING_CHANGED', message: 'This booking is no longer pending and could not be confirmed.' }, 409);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('accept-booking:', err);
    // Land it where an operator will actually see it (/errors in the admin
    // console). This used to stop at console.error, so a money-path failure
    // was invisible unless someone was tailing Supabase function logs.
    await logServerError('accept-booking', `Booking acceptance failed after the hold was placed: ${errMessage(err)}`,
      { booking_id: errBookingId }, { fatal: true, userId: errUserId });
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
