// Charges the poster's saved card off-session for a tip and routes it (in full)
// to the earner's Connect account. Called after a job is verified.
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

  // Carried outside the try so the terminal catch can name WHICH tip failed, the same
  // way accept-booking carries errBookingId/errUserId.
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
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);
    errUserId = user.id;

    const { bookingId, tipCents } = await req.json();
    errBookingId = typeof bookingId === 'string' ? bookingId : null;
    // Bound the tip (50¢–$1000) — it charges the poster's card off-session.
    if (!bookingId || !tipCents || tipCents < 50 || tipCents > 100_000) {
      return json({ error: 'A valid tip amount (50¢–$1000) is required' }, 400);
    }

    // Fails OPEN by design — a broken flag check must not stop a legitimate payment
    // — but it is logged, because a silent fail-open means /flags shows the feature
    // paused while it is still running.
    const { data: tipFlag, error: tipFlagErr } = await supabase.rpc('app_flag', { p_key: 'tips_enabled' });
    if (tipFlagErr) console.error('stripe-tip: app_flag check failed — proceeding (fail-open):', tipFlagErr);
    if (tipFlag === false) {
      return json({ error: 'TIPS_PAUSED', message: 'Tipping is briefly paused. Please try again shortly.' }, 503);
    }

    // Verify the caller is the poster of this booking
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(title, poster_id)')
      .eq('id', bookingId)
      .single();
    if (!booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
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

    // ── Reserve the headroom BEFORE any money moves ──────────────────────────
    // This used to be `rpc('tip_headroom_cents')` — a `stable`, lock-free READ, in its
    // own round trip, and a read consumes nothing. N concurrent callers all got the
    // same answer and all passed; because the old idempotency key was
    // `tip_${booking}_${cents}`, varying the amount by a cent produced N genuinely
    // distinct PaymentIntents that never collided. The advisory locks in
    // trg_guard_tip_caps only fired afterwards, at credit time — AFTER the card was
    // charged — and every rejection rolled back its own ledger row, so the over-cap
    // money never counted toward the next attempt's cap either.
    //
    // The gate is now a WRITE. reserve_tip_slot inserts an uncharged tip_ledger row,
    // which makes trg_guard_tip_caps evaluate all three caps under its own locks at
    // the moment headroom is taken. The cap arithmetic still lives in exactly one
    // place — the trigger — and this function no longer knows what the limits are.
    const { data: reservation, error: capErr } = await supabase.rpc('reserve_tip_slot', {
      p_booking: bookingId,
      p_cents: Math.round(tipCents),
    });
    if (capErr) {
      // FAIL CLOSED. Not being able to reserve is not a reason to charge an
      // unreserved amount to someone's card.
      console.error('stripe-tip: tip reservation failed — refusing:', capErr);
      return json({ error: 'Tip limits are unavailable right now. Please try again.' }, 503);
    }
    if (!reservation?.ok) {
      const reason = reservation?.reason ?? 'tip_cap_booking';
      const remaining = Number(reservation?.headroom_cents ?? 0);

      // NOT every refusal is a cap. reserve_tip_slot also returns tip_invalid (the booking
      // is not in a tippable state) and tip_reserve_failed (the reservation row vanished
      // between the insert and the read). Both used to fall through to the cap wording
      // below and told the poster their tip was "larger than this gig allows" — which is
      // false, unactionable, and sends them to support with the wrong question. The `code`
      // always carried the truth; only the sentence was wrong.
      if (reason === 'tip_invalid' || reason === 'tip_reserve_failed') {
        return json({
          error: 'This gig cannot be tipped right now. Please try again in a moment.',
          code: reason,
        }, 409);
      }

      return json({
        error:
          reason === 'tip_cap_count'
            ? 'This gig has already been tipped the maximum number of times.'
            : reason === 'tip_cap_velocity'
              ? 'You have reached the daily tipping limit. Try again tomorrow.'
              : remaining > 0
                ? `Tips on this gig are capped — you can add up to $${(remaining / 100).toFixed(2)} more.`
                : 'That tip is larger than this gig allows.',
        code: reason,
        remainingCents: Math.max(0, remaining),
      }, 409);
    }
    const reservationKey: string = reservation.key;

    // The Stripe idempotency key is the reservation ROW (`resv_<row id>`), NOT the slot
    // key. They were one string until 20260906014000, and that conflated two different
    // lifetimes: the slot key is deterministic per (booking, cents) and is released on
    // confirm — but Stripe remembers a key for 24 hours, so the next legitimate tip of
    // the same amount was answered with the FIRST PaymentIntent, no card was charged,
    // confirm_tip_charge found the already-credited first row by PI, and this function
    // reported success. The row id is stable exactly as long as the reservation is,
    // which is precisely the window in which a replay is what we want.
    //
    // The derivation from reservation_id is the same shape reserve_tip_slot returns, and
    // covers this function being deployed ahead of the migration. There is deliberately
    // no third fallback to `reservation.key`: that is the replay this fixes, so refuse.
    const stripeKey: string = reservation.stripe_key
      ?? (reservation.reservation_id ? `resv_${reservation.reservation_id}` : '');
    if (!stripeKey) {
      await supabase.rpc('release_tip_reservation', { p_key: reservationKey });
      console.error('stripe-tip: reservation returned no row handle — refusing to charge:', reservation);
      return json({ error: 'Tip limits are unavailable right now. Please try again.' }, 503);
    }

    // Off-session charge → full tip to earner (no platform fee on tips).
    //
    // A double tap still collapses onto one PaymentIntent: reserve_tip_slot reuses the
    // live reservation, so both taps get the same row and the same key. A retry after a
    // timeout is exactly-once for the same reason — the reservation is still there,
    // Stripe replays the same PaymentIntent, and confirm_tip_charge attaches it. And a
    // second charge still cannot exist without a second reservation having passed the
    // caps, because the key names the row that consumed the headroom.
    let pi;
    try {
      pi = await stripe.paymentIntents.create({
        amount: Math.round(tipCents),
        currency: 'usd',
        customer: cust.customer_id,
        payment_method: pmId,
        off_session: true,
        confirm: true,
        transfer_data: { destination: earnerAcct.account_id },
        description: `GoHustlr tip: ${one(booking.job)?.title}`,
        metadata: {
          booking_id: bookingId,
          type: 'tip',
          earner_id: booking.earner_id,
          poster_id: user.id,
          reservation: reservationKey,
          reservation_id: String(reservation.reservation_id ?? ''),
        },
      }, { idempotencyKey: stripeKey });
    } catch (chargeErr: any) {
      // Release ONLY on a definitive decline. An ambiguous failure (timeout, network,
      // Stripe 5xx) may have created the charge anyway, and giving the slot back would
      // let a second charge in beside it. Those reservations expire on their own —
      // reserved_until is excluded from every cap query — so nothing is held forever
      // and the reservation's own key makes the retry land on the same PaymentIntent.
      if (chargeErr?.type === 'StripeCardError' || chargeErr?.code === 'authentication_required') {
        await supabase.rpc('release_tip_reservation', { p_key: reservationKey });
      }
      throw chargeErr;
    }

    if (pi.status !== 'succeeded') {
      if (pi.status === 'requires_payment_method' || pi.status === 'canceled') {
        await supabase.rpc('release_tip_reservation', { p_key: reservationKey });
      }
      return json({ error: `Tip not completed (${pi.status})` }, 400);
    }

    // Attach the real PaymentIntent to the reservation and credit, in ONE transaction,
    // claiming a `credited` flag — so a Stripe idempotent replay is a no-op and a retry
    // after a mid-way failure still credits exactly once. The cap can no longer fire
    // here: the row was admitted by the trigger before the card was touched, and
    // confirm is an UPDATE.
    const { data: confirmed, error: creditErr } = await supabase.rpc('confirm_tip_charge', {
      p_key: reservationKey,
      p_pi: pi.id,
    });
    if (creditErr || confirmed !== true) {
      // MONEY HAS ALREADY MOVED. The card is charged and the funds are on their way
      // to the earner's connected account, but our ledger did not record it — so the
      // earner's dashboard is short and nothing will reconcile it on its own.
      // ctl_earner_credit_missing raises the reservation row after 15 minutes, but
      // page it now rather than returning a generic 500 nobody investigates.
      await logServerError(
        'stripe-tip',
        `Tip charged but NOT credited — manual reconciliation required: ${
          creditErr ? errMessage(creditErr) : 'the reservation was gone at confirm time'
        }`,
        {
          payment_intent: pi.id,
          booking_id: bookingId,
          earner_id: booking.earner_id,
          tip_cents: Math.round(tipCents),
          reservation_key: reservationKey,
          action: 'service_role: select public.confirm_tip_charge(reservation_key, payment_intent) '
            + '— or refund the PaymentIntent in Stripe',
        },
        { fatal: true, userId: user.id },
      );
      throw creditErr ?? new Error('tip_confirm_failed');
    }

    return json({ success: true, tipCents: Math.round(tipCents) });
  } catch (err: any) {
    console.error('stripe-tip:', err);
    // A saved card that needs off-session SCA throws authentication_required (or a
    // generic StripeCardError). Surface a distinct, actionable code so the client
    // can tell the poster their card needs re-verification, instead of a generic
    // 500. No money moved (the off-session confirm failed), and a later successful retry
    // is still exactly-once — but by the RESERVATION now, not claim_and_credit_tip: the
    // reservation row already holds this slot, and its own id is the Stripe key, so the
    // retry reuses both and confirm_tip_charge does the crediting. If this attempt dies here the
    // reservation is left behind deliberately, times out of the caps on its own, and
    // ctl_earner_credit_missing raises it as tip_reservation_unconfirmed with the key an
    // operator needs.
    const cardDeclined = err?.type === 'StripeCardError' || err?.code === 'authentication_required';
    // Land it in /errors like every other money function. A declined card is the
    // poster's to fix and is not fatal; anything else reaching here is a tip that did
    // not happen for a reason nobody could see — this catch used to stop at
    // console.error, so the only trace was a Supabase function log nobody tails.
    await logServerError('stripe-tip',
      `Tip failed: ${errMessage(err)}`,
      {
        booking_id: errBookingId,
        stripe_error_code: err?.code ?? null,
        stripe_error_type: err?.type ?? null,
        card_declined: cardDeclined,
      },
      { fatal: !cardDeclined, userId: errUserId });
    if (cardDeclined) {
      return json({ error: 'card_requires_authentication' }, 402);
    }
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
