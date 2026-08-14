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
import { type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { logServerError, errMessage } from '../_shared/logError.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let bookingId: string | null = null;
  let op: string | null = null;
  // Both visible to the catch below, which must release the in-flight refund marker.
  let paymentRowId: string | null = null;
  let serviceRef: SupabaseClient | null = null;

  try {
    // 300s step-up. This function issues Stripe refunds and voids escrow holds — the
    // single most damaging thing an admin token can do — and until now it accepted any
    // AAL2 token of any age, so the console's step-up gating did not apply to the one
    // place money actually leaves. A 'stale_mfa' denial is recoverable: the console
    // prompts for a code and retries.
    const auth = await requireAdminCaller(req, 'admin', 300);
    if (!auth.ok) return json({ error: auth.denial.error }, auth.denial.status);
    const { service, user } = auth.caller;
    serviceRef = service;

    const body = await req.json();
    bookingId = typeof body.bookingId === 'string' ? body.bookingId : null;
    op = typeof body.op === 'string' ? body.op : null;
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    const amountCents = Number.isFinite(body.amountCents) ? Math.round(body.amountCents) : null;
    // Minted once per populated form in the console and rotated only on success, so an
    // operator retrying an unchanged form reuses it and Stripe replays instead of
    // issuing a second real refund. Constrained to a safe key charset.
    const requestId = String(body.requestId ?? '').trim().slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');

    if (!bookingId) return json({ error: 'booking_required' }, 400);
    if (op !== 'release_hold' && op !== 'refund' && op !== 'record_reversal') return json({ error: 'bad_op' }, 400);
    if (!reason) return json({ error: 'reason_required', message: 'A written reason is required.' }, 400);

    const { data: pay, error: payErr } = await service
      .from('payments')
      .select('id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents, refunded_cents, refunded_at, status')
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
      const alreadyReversed = pay.refunded_cents ?? 0;
      const remaining = capturedC - alreadyReversed;

      // A retry after the console's 20s abort lands HERE, not on the ledger's UNIQUE
      // index: attempt 1 already moved refunded_cents, so the console's blank amount
      // resolves to 0 remaining and the zero check below rejected it — as a bare
      // `bad_amount` with no message, which InterventionPanel prints verbatim in red.
      // An operator reading "bad_amount" after a timeout concludes the button is broken
      // and clicks again.
      //
      // Still an error rather than a success, deliberately: refunded_cents does not say
      // WHICH kind of reversal consumed the charge, and recordReversal's success text is
      // fixed ("Recorded $X as reversed") — echoing it at someone whose charge was
      // already fully REFUNDED would report a lost chargeback as filed when nothing
      // filed it, burying the exact accounting gap this op exists to close. The
      // timestamp is what lets the operator tell their own timed-out click from a
      // reversal recorded last week.
      if (alreadyReversed > 0 && remaining <= 0) {
        return json({
          error: 'already_reversed',
          message:
            `This charge is already fully reversed — $${(alreadyReversed / 100).toFixed(2)} was recorded` +
            `${pay.refunded_at ? ` at ${pay.refunded_at}` : ''}. If that was this reversal timing out, ` +
            'it landed; there is nothing further to record.',
        }, 409);
      }

      const cents = amountCents == null ? remaining : amountCents;
      if (cents <= 0) return json({ error: 'bad_amount', message: 'A reversal must be more than zero.' }, 400);

      await service.from('payments').update({ refund_source: 'chargeback' }).eq('id', pay.id);
      // p_debit_earner: FALSE. This op makes no stripe.* call — a chargeback on a
      // destination charge debits the PLATFORM balance and does not reverse the
      // transfer, so the earner's money is already with them and stays there.
      // debit_earnings would recover nothing; it would only make their displayed
      // earnings smaller than what they were actually paid, for something the poster's
      // cardholder did. RUNBOOK_MONEY:78 already says the platform eats it.
      const { data: total, error: recErr } = await service.rpc('record_refund', {
        p_payment_id: pay.id, p_cents: cents, p_reason: reason, p_admin: user.id,
        p_debit_earner: false,
        // No Stripe object exists for a ledger-only reversal, so the key is derived
        // from what an accidental resubmit repeats: this PaymentIntent and this
        // amount. InterventionPanel clears the form only on success, so after a
        // timeout the operator's second click sends byte-identical values — that is
        // the case this collapses. The reason text is deliberately NOT part of the
        // key: a retyped word would sail straight past it.
        //
        // NOT requestId, unlike the refund path below: recordReversal in the console's
        // actions.ts does not forward one, so keying on it here would mean no dedupe at
        // all rather than a different dedupe. Unifying the two keys needs that wired up
        // first — refundIdempotency.test.js pins this shape for that reason.
        p_external_id: `chargeback_${pay.payment_intent_id}_${cents}`,
      });
      if (recErr) throw new Error(recErr.message);
      if (total === null) {
        return json({
          error: 'over_refund',
          message: `Only ${(remaining / 100).toFixed(2)} of this charge is still unreversed.`,
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
    const ourRefunded = pay.refunded_cents ?? 0;

    // ASK STRIPE what it has already refunded, and cap against the LARGER figure.
    //
    // Capping on our own refunded_cents alone is wrong in exactly the case an operator
    // is most likely to be here for: a refund issued in the Stripe Dashboard never
    // moves our column, so ctl_external_reversal_not_ledgered fires with
    // refunded_cents = 0 and the console cheerfully offers the whole capture as
    // refundable. Following that offer issues a SECOND real refund with
    // reverse_transfer:true — the poster is paid twice and the money is clawed out of
    // the earner's connected account for an overpayment that never happened.
    //
    // Fail CLOSED: if Stripe cannot be read we do not know what is already refunded, and
    // refunding on a stale local figure is the failure this exists to prevent.
    let stripeRefunded = 0;
    try {
      const pi = await stripe.paymentIntents.retrieve(pay.payment_intent_id, { expand: ['latest_charge'] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      stripeRefunded = typeof charge?.amount_refunded === 'number' ? charge.amount_refunded : 0;
    } catch (e) {
      await logServerError('admin-payment-action',
        `could not read Stripe refund state for ${pay.payment_intent_id}: ${String((e as Error)?.message ?? e)}`,
        { booking_id: bookingId, payment_id: pay.id }, { fatal: true });
      return json({
        error: 'stripe_unreadable',
        message: 'Could not confirm what Stripe has already refunded on this charge. Refusing to refund on a stale figure — try again.',
      }, 503);
    }

    const alreadyRefunded = Math.max(ourRefunded, stripeRefunded);
    if (stripeRefunded > ourRefunded) {
      // Not fatal to the refund, but the operator must know the ledger is behind.
      await logServerError('admin-payment-action',
        `Stripe reports ${stripeRefunded}c refunded on ${pay.payment_intent_id} but our ledger has ${ourRefunded}c — capping against Stripe`,
        { booking_id: bookingId, payment_id: pay.id }, { fatal: false });
    }
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

    // Idempotency keyed on the operator's REQUEST, not on our running total.
    //
    // `refund_${pi}_${alreadyRefunded + refundCents}` looked idempotent and was not. The
    // console aborts at 20s while record_refund commits in about one, so the likely
    // retry ordering is "attempt 1 fully committed, the response was lost" — and then
    // attempt 2 re-reads the NEW refunded_cents and builds a DIFFERENT key. Stripe does
    // not replay; it issues a genuinely new refund. The poster receives $60 for a $30
    // intent and the earner is reverse-transferred twice. refund_ledger cannot catch it
    // either, because Stripe's refund.id differs.
    //
    // requestId is minted once per populated form in InterventionPanel and only rotates
    // on success, so retrying an unchanged form reuses it and Stripe replays. Falls back
    // to the old shape for any caller that does not send one.
    // Mark the source BEFORE the Stripe call. stripe-webhook's charge.refunded
    // handler files a disputes row for every reversal it sees, and it cannot tell an
    // operator-initiated refund from a customer chargeback — so without this marker,
    // remediating a booking immediately filed a NEW open dispute against it, which
    // earner-claim-payment then treats as a reason to refuse settlement. The console
    // re-blocked the thing it had just fixed. Set first because the webhook can
    // arrive before this function returns.
    // refund_source_at time-bounds the marker: even if some future path forgets to
    // clear it, stripe-webhook stops honouring it after a few minutes rather than
    // skipping every reversal on this payment forever.
    paymentRowId = pay.id;
    await service.from('payments')
      .update({ refund_source: 'admin', refund_source_at: new Date().toISOString() })
      .eq('id', pay.id);

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
      {
        idempotencyKey: requestId
          ? `refund_${pay.payment_intent_id}_${requestId}`
          : `refund_${pay.payment_intent_id}_${alreadyRefunded + refundCents}`,
      },
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
      // TRUE here, and earned: this path passed reverse_transfer to Stripe above, so the
      // money genuinely came back out of the earner's connected account.
      p_debit_earner: true,
      // Stripe's own refund id — the ONE value that differs between a genuine second
      // refund and a replay of the first. The idempotency key above protects Stripe;
      // this protects the ledger. Without it, a retry after the 20s timeout re-reads
      // refunded_cents = 0, rebuilds the same key, receives the ORIGINAL Refund object
      // back, and records a second refund that never happened.
      p_external_id: refund.id,
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
    // Release the in-flight marker. It is stamped BEFORE the Stripe call so a fast
    // webhook does not file a dispute against our own refund, and record_refund clears
    // it on success — but a throw between the two used to leave it set FOREVER, and
    // stripe-webhook skips on it. Every later external reversal on that payment then
    // went unrecorded, which is precisely the bug the marker's scoping was meant to end.
    // Best-effort: this is already the failure path and must not mask the real error.
    try {
      if (paymentRowId && serviceRef) {
        await serviceRef.from('payments')
          .update({ refund_source: null, refund_source_at: null })
          .eq('id', paymentRowId);
      }
    } catch (_) { /* the time bound on refund_source_at is the backstop */ }
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
