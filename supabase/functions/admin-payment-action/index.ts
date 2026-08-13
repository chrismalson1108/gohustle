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
import Stripe from 'npm:stripe@22';
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
    // 300s step-up. This function issues Stripe refunds and voids escrow holds — the
    // single most damaging thing an admin token can do — and until now it accepted any
    // AAL2 token of any age, so the console's step-up gating did not apply to the one
    // place money actually leaves. A 'stale_mfa' denial is recoverable: the console
    // prompts for a code and retries.
    const auth = await requireAdminCaller(req, 'admin', 300);
    if (!auth.ok) return json({ error: auth.denial.error }, auth.denial.status);
    const { service, user } = auth.caller;

    const body = await req.json();
    bookingId = typeof body.bookingId === 'string' ? body.bookingId : null;
    op = typeof body.op === 'string' ? body.op : null;
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    const amountCents = Number.isFinite(body.amountCents) ? Math.round(body.amountCents) : null;

    if (!bookingId) return json({ error: 'booking_required' }, 400);
    if (op !== 'release_hold' && op !== 'refund' && op !== 'record_reversal') return json({ error: 'bad_op' }, 400);
    if (!reason) return json({ error: 'reason_required', message: 'A written reason is required.' }, 400);

    const { data: pay, error: payErr } = await service
      .from('payments')
      .select('id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents, refunded_cents, status')
      .eq('booking_id', bookingId)
      .maybeSingle();
    if (payErr) return json({ error: 'lookup_failed', message: payErr.message }, 503);
    if (!pay) return json({ error: 'no_payment', message: 'No payment record for this booking.' }, 404);

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });

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
      //
      // BUT `payment_intent_unexpected_state` is ALSO what Stripe returns for an
      // already-SUCCEEDED (captured) intent. Swallowing it blindly stamped the row
      // 'cancelled' and told the operator "the poster was never charged" when the
      // poster had in fact been charged and the earner credited — and the row then
      // failed the refund guard below forever, making the only money that actually
      // moved invisible to every tool in the console. This state is reachable
      // whenever a capture succeeded at Stripe but our follow-up update lost the
      // race with the webhook. Probe before concluding anything.
      try {
        await stripe.paymentIntents.cancel(pay.payment_intent_id);
      } catch (e: any) {
        if (e?.code !== 'payment_intent_unexpected_state') throw e;

        const pi = await stripe.paymentIntents.retrieve(pay.payment_intent_id);
        if (pi.status === 'succeeded' || (pi.amount_received ?? 0) > 0) {
          // Reconcile the row to the truth rather than writing a comfortable lie,
          // then refuse — the operator wants the refund path, not this one.
          await service.from('payments')
            .update({ status: 'captured', captured_at: new Date().toISOString() })
            .eq('id', pay.id).eq('status', 'authorized');
          return json({
            error: 'already_captured',
            message:
              'This payment was already CAPTURED at Stripe — the poster has been charged. ' +
              'The record has been corrected; refund it instead of releasing the hold.',
          }, 409);
        }
        // Genuinely already void/expired — fall through and let the DB catch up.
      }

      const { error: updErr } = await service
        .from('payments')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', pay.id);
      if (updErr) throw new Error(`hold released in Stripe but DB update failed: ${updErr.message}`);

      return json({ ok: true, op, released_cents: pay.amount_cents });
    }

    // ── Record a reversal that happened OUTSIDE Stripe's refund API ──────────
    // A LOST CHARGEBACK takes the money back but is not a refund: Stripe rejects
    // refunds.create on a disputed charge (charge_disputed). RUNBOOK_MONEY told the
    // operator to use the Refund control for this, which could only ever fail — so
    // GMV kept overstating revenue by the value of every chargeback lost. This is
    // the ledger-only path: no Stripe call, same accounting, distinctly labelled.
    if (op === 'record_reversal') {
      if (pay.status !== 'captured') {
        return json({ error: 'not_captured', message: 'Only a captured charge can carry a reversal.' }, 409);
      }
      const capturedC = (pay.earner_amount_cents ?? 0) + (pay.fee_cents ?? 0);
      const cents = amountCents == null ? capturedC - (pay.refunded_cents ?? 0) : amountCents;
      if (cents <= 0) return json({ error: 'bad_amount' }, 400);

      await service.from('payments').update({ refund_source: 'chargeback' }).eq('id', pay.id);
      const { data: total, error: recErr } = await service.rpc('record_refund', {
        p_payment_id: pay.id, p_cents: cents, p_reason: reason, p_admin: user.id,
      });
      if (recErr) throw new Error(recErr.message);
      if (total === null) {
        return json({
          error: 'over_refund',
          message: `Only ${((capturedC - (pay.refunded_cents ?? 0)) / 100).toFixed(2)} of this charge is still unreversed.`,
        }, 409);
      }
      return json({ ok: true, op, refunded_cents: cents });
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
    // Mark the source BEFORE the Stripe call. stripe-webhook's charge.refunded
    // handler files a disputes row for every reversal it sees, and it cannot tell an
    // operator-initiated refund from a customer chargeback — so without this marker,
    // remediating a booking immediately filed a NEW open dispute against it, which
    // earner-claim-payment then treats as a reason to refuse settlement. The console
    // re-blocked the thing it had just fixed. Set first because the webhook can
    // arrive before this function returns.
    await service.from('payments').update({ refund_source: 'admin' }).eq('id', pay.id);

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

    // record_refund adds IN SQL under a row lock and debits the earner's in-app
    // earnings in the same transaction. The previous read-modify-write let two
    // concurrent refunds both compute from the same stale base, and nothing
    // decremented profiles.earnings_* at all — so the earner's "Total earned" kept
    // money Stripe had already clawed back out of their connected balance.
    const { data: newTotal, error: updErr } = await service.rpc('record_refund', {
      p_payment_id: pay.id,
      p_cents: refundCents,
      p_reason: reason,
      p_admin: user.id,
    });
    if (!updErr && newTotal === null) {
      // Lost a race with a concurrent refund: Stripe took the money but the running
      // total would now exceed what was collected. Surface it as a desync rather
      // than a clean success.
      await logServerError(
        'admin-payment-action',
        'Refund SUCCEEDED in Stripe but exceeded the refundable total (concurrent refund) — reconcile by hand',
        { booking_id: bookingId, payment_intent: pay.payment_intent_id, refund_id: refund.id, refund_cents: refundCents },
        { fatal: true, userId: user.id },
      );
      return json({
        error: 'ledger_desync',
        message: `Refund ${refund.id} went through at Stripe but exceeded the refundable total — a concurrent refund likely landed first. This is logged for reconciliation.`,
      }, 409);
    }
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
