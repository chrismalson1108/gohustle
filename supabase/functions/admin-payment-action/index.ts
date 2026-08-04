// Admin money remediation. THE console's only path to moving money.
//
// WHY THIS EXISTS: the admin console had 19 server actions and not one of them
// moved money. There was no refund code anywhere in the repo, and payments.status
// could not represent a reversal at all, so every remediation was "open the Stripe
// Dashboard" — which silently desynced the ledger, because a Dashboard capture
// fires payment_intent.succeeded and that handler credits the earner the full
// pre-computed split without reading amount_received.
//
// Two operations, both reconciled against Stripe's own numbers rather than ours:
//   • release_hold — void an uncaptured authorization. Nobody is charged.
//   • refund       — refund a captured charge, fully or partially.
//
// ADMIN TIER ONLY. Support may read the money pages; only an admin may move money.
// The console writes its admin_audit_log row BEFORE calling this, so an action that
// reaches Stripe is always already on the record.
import Stripe from 'npm:stripe@15';
import { requireAdminCaller } from '../_shared/adminAuth.ts';
import { logServerError, errMessage } from '../_shared/logError.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let bookingId: string | null = null;
  let op: string | null = null;

  try {
    const auth = await requireAdminCaller(req, 'admin');
    if (!auth.ok) return json({ error: auth.denial.error }, auth.denial.status);
    const { service, user } = auth.caller;

    const body = await req.json();
    bookingId = typeof body.bookingId === 'string' ? body.bookingId : null;
    op = typeof body.op === 'string' ? body.op : null;
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    const amountCents = Number.isFinite(body.amountCents) ? Math.round(body.amountCents) : null;

    if (!bookingId) return json({ error: 'booking_required' }, 400);
    if (op !== 'release_hold' && op !== 'refund') return json({ error: 'bad_op' }, 400);
    if (!reason) return json({ error: 'reason_required', message: 'A written reason is required.' }, 400);

    const { data: pay, error: payErr } = await service
      .from('payments')
      .select('id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents, refunded_cents, status')
      .eq('booking_id', bookingId)
      .maybeSingle();
    if (payErr) return json({ error: 'lookup_failed', message: payErr.message }, 503);
    if (!pay) return json({ error: 'no_payment', message: 'No payment record for this booking.' }, 404);

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

    // ── Release an uncaptured authorization ──────────────────────────────────
    if (op === 'release_hold') {
      if (pay.status !== 'authorized') {
        return json({
          error: 'not_authorized_state',
          message: `This payment is "${pay.status}", not an open hold. Only an uncaptured authorization can be released.`,
        }, 409);
      }

      // Ask Stripe first. If the hold already lapsed or was voided elsewhere, treat
      // that as success and let the DB catch up — the goal state is "no hold", and
      // erroring here would leave our row permanently disagreeing with Stripe.
      try {
        await stripe.paymentIntents.cancel(pay.payment_intent_id);
      } catch (e: any) {
        const already = e?.code === 'payment_intent_unexpected_state';
        if (!already) throw e;
      }

      const { error: updErr } = await service
        .from('payments')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', pay.id);
      if (updErr) throw new Error(`hold released in Stripe but DB update failed: ${updErr.message}`);

      return json({ ok: true, op, released_cents: pay.amount_cents });
    }

    // ── Refund a captured charge ─────────────────────────────────────────────
    if (pay.status !== 'captured') {
      return json({
        error: 'not_captured',
        message: `This payment is "${pay.status}". Only a captured charge can be refunded — release the hold instead.`,
      }, 409);
    }

    // What was actually collected. amount_cents is the ORIGINAL AUTHORIZATION and is
    // never rewritten, so refunding against it would let a partially-captured booking
    // be refunded for more than the poster ever paid.
    const capturedCents = (pay.earner_amount_cents ?? 0) + (pay.fee_cents ?? 0);
    const alreadyRefunded = pay.refunded_cents ?? 0;
    const remaining = capturedCents - alreadyRefunded;
    if (remaining <= 0) {
      return json({ error: 'already_refunded', message: 'This charge is already fully refunded.' }, 409);
    }

    const refundCents = amountCents == null ? remaining : amountCents;
    if (refundCents <= 0) return json({ error: 'bad_amount', message: 'Refund must be more than zero.' }, 400);
    if (refundCents > remaining) {
      return json({
        error: 'over_refund',
        message: `Only ${(remaining / 100).toFixed(2)} remains refundable on this charge.`,
      }, 409);
    }

    // Idempotency keyed on payment + running total, so a double-submit cannot refund
    // twice while a genuine second partial refund still goes through.
    const refund = await stripe.refunds.create(
      {
        payment_intent: pay.payment_intent_id,
        amount: refundCents,
        // The earner's money already left via the destination transfer; pull it back
        // from the connected account rather than eating it on the platform balance.
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: { booking_id: bookingId, admin_id: user.id, reason },
      },
      { idempotencyKey: `refund_${pay.payment_intent_id}_${alreadyRefunded + refundCents}` },
    );

    const { error: updErr } = await service
      .from('payments')
      .update({
        refunded_cents: alreadyRefunded + refundCents,
        refunded_at: new Date().toISOString(),
        refund_reason: reason,
        refunded_by: user.id,
      })
      .eq('id', pay.id);
    if (updErr) {
      // MONEY HAS MOVED and our ledger does not know. Page it — GMV and the earner's
      // balance are now both wrong and nothing reconciles this on its own.
      await logServerError(
        'admin-payment-action',
        `Refund SUCCEEDED in Stripe but the ledger update failed: ${updErr.message}`,
        { booking_id: bookingId, payment_intent: pay.payment_intent_id, refund_id: refund.id, refund_cents: refundCents },
        { fatal: true, userId: user.id },
      );
      return json({ error: 'ledger_desync', message: `Refund went through (${refund.id}) but the ledger update failed. This is logged for reconciliation.` }, 500);
    }

    return json({ ok: true, op, refunded_cents: refundCents, refund_id: refund.id });
  } catch (err) {
    console.error('admin-payment-action:', err);
    await logServerError(
      'admin-payment-action',
      `Admin money action failed (${op ?? 'unknown'}): ${errMessage(err)}`,
      { booking_id: bookingId, op },
      { fatal: true },
    );
    return json({ error: 'server_error', message: errMessage(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
