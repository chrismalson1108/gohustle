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

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });
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

    // ── Tip caps, checked BEFORE any money moves ─────────────────────────────
    // The 50¢–$1000 bound above is PER CALL, and the idempotency key below
    // includes the amount — so varying the amount mints a fresh PaymentIntent and
    // the per-call bound caps nothing cumulative. Tips also carry no
    // application_fee_amount, so 100% lands in the earner's connected balance and
    // pays out daily. Uncapped, that is a fee-free money-movement channel.
    //
    // trg_guard_tip_caps on tip_ledger is the authoritative backstop, but it runs
    // at claim_and_credit_tip time — AFTER the card has been charged, which would
    // strand the poster's money in the connected account. So the cap is checked
    // here first and the trigger should never fire in practice.
    const { data: headroom, error: capErr } = await supabase.rpc('tip_headroom_cents', {
      p_booking: bookingId,
    });
    if (capErr) {
      // FAIL CLOSED. Not knowing the remaining headroom is not a reason to charge
      // an unbounded amount to someone's card.
      console.error('stripe-tip: cap check failed — refusing:', capErr);
      return json({ error: 'Tip limits are unavailable right now. Please try again.' }, 503);
    }
    const remaining = Number(headroom?.headroom_cents ?? 0);
    if (Math.round(tipCents) > remaining) {
      const reason = headroom?.reason ?? 'tip_cap_booking';
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
      description: `GoHustlr tip: ${one(booking.job)?.title}`,
      metadata: { booking_id: bookingId, type: 'tip', earner_id: booking.earner_id, poster_id: user.id },
    }, { idempotencyKey: `tip_${bookingId}_${Math.round(tipCents)}` });

    if (pi.status !== 'succeeded') return json({ error: `Tip not completed (${pi.status})` }, 400);

    // Record + credit the tip ATOMICALLY and exactly once. claim_and_credit_tip
    // inserts the idempotency ledger row (unique on the PaymentIntent id) AND credits
    // bookings.tip_amount + the earner's earnings in ONE transaction, claiming a
    // `credited` flag. So a Stripe idempotent replay (same booking+amount) is a
    // no-op, and a retry after a mid-way failure still credits exactly once (the
    // ledger row exists but credited is still false). Replaces the previous
    // ledger-insert-then-separate-credit, which could strand an un-credited tip.
    const { error: creditErr } = await supabase.rpc('claim_and_credit_tip', {
      p_pi: pi.id,
      p_booking: bookingId,
      p_earner: booking.earner_id,
      p_cents: Math.round(tipCents),
    });
    if (creditErr) {
      // MONEY HAS ALREADY MOVED. The card is charged and the funds are on their way
      // to the earner's connected account, but our ledger did not record it — so the
      // earner's dashboard is short and nothing will reconcile it on its own.
      // The likeliest cause is trg_guard_tip_caps firing on a race the pre-check
      // above couldn't see (two concurrent tips). Page it loudly rather than
      // returning a generic 500 nobody investigates.
      await logServerError(
        'stripe-tip',
        `Tip charged but NOT credited — manual reconciliation required: ${errMessage(creditErr)}`,
        {
          payment_intent: pi.id,
          booking_id: bookingId,
          earner_id: booking.earner_id,
          tip_cents: Math.round(tipCents),
          action: 'refund the PaymentIntent in Stripe, or credit the earner by hand',
        },
        { fatal: true, userId: user.id },
      );
      throw creditErr;
    }

    return json({ success: true, tipCents: Math.round(tipCents) });
  } catch (err: any) {
    console.error('stripe-tip:', err);
    // A saved card that needs off-session SCA throws authentication_required (or a
    // generic StripeCardError). Surface a distinct, actionable code so the client
    // can tell the poster their card needs re-verification, instead of a generic
    // 500. No money moved (the off-session confirm failed), and the idempotency key
    // + claim_and_credit_tip ledger keep any later successful retry exactly-once.
    if (err?.type === 'StripeCardError' || err?.code === 'authentication_required') {
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
