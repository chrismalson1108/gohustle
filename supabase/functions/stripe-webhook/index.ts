// Stripe webhook handler — keeps DB in sync with payment events.
// Register this URL in Stripe Dashboard → Developers → Webhooks:
//   https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-webhook
// Required events: payment_intent.succeeded, payment_intent.payment_failed,
//   payment_intent.canceled, account.updated,
//   charge.dispute.created, charge.refunded,
//   identity.verification_session.verified, identity.verification_session.requires_input,
//   identity.verification_session.canceled
import Stripe from 'npm:stripe@22';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { logServerError } from '../_shared/logError.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

const NOTIFY_FROM = 'GoHustlr <notifications@gohustlr.com>';
const ADMIN_NOTIFY = 'mainmail@gohustlr.com';

function esc(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

// Best-effort admin alert — never throws, so a Resend outage can't wedge the webhook
// (Stripe would otherwise retry and we'd re-run the DB writes). Logs loudly if unsent.
async function emailAdmin(subject: string, html: string): Promise<void> {
  try {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      console.error(`[stripe-webhook] RESEND_API_KEY unset — could not email admin: ${subject}`);
      return;
    }
    const to = Deno.env.get('SAFETY_ONCALL_EMAIL') || ADMIN_NOTIFY;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, html }),
    });
    if (!res.ok) console.error('[stripe-webhook] resend error:', await res.text().catch(() => res.status));
  } catch (e) {
    console.error('[stripe-webhook] emailAdmin failed:', e);
  }
}

// Record a payment-reversal event (chargeback / refund) against the booking as a
// `disputes` row. An open disputes row is exactly what earner-claim-payment (and the
// poster capture path) treat as "under dispute", so this ALSO suppresses any further
// auto-capture on the booking. Idempotent: keyed on the Stripe object id embedded in
// the reason, so Stripe redeliveries don't duplicate. Returns the booking_id if found.
async function recordReversal(
  supabase: SupabaseClient,
  paymentIntentId: string | null,
  externalId: string,
  reason: string,
  // 'refund'  — Stripe charge.refunded, which an ADMIN refund also fires
  // 'chargeback' — charge.dispute.created, which only a CARDHOLDER can cause
  kind: 'refund' | 'chargeback',
  // charge.amount_refunded — Stripe's CUMULATIVE refunded total for this charge.
  // Null for a chargeback, which moves no refund figure at all.
  stripeRefundedCents: number | null = null,
): Promise<string | null> {
  if (!paymentIntentId) return null;
  const { data: payment } = await supabase
    .from('payments').select('id, booking_id, refund_source, refunded_cents')
    .eq('payment_intent_id', paymentIntentId).maybeSingle();
  const bookingId = (payment as { booking_id?: string } | null)?.booking_id;
  if (!bookingId) return null;

  // An ADMIN-initiated refund is a remediation, not a new complaint. Filing a
  // disputes row for it created a loop: the console refunds a booking, Stripe fires
  // charge.refunded, this records a fresh OPEN dispute, and earner-claim-payment
  // then refuses to settle that booking — so fixing a problem re-blocked it. Still
  // return the booking id so the caller's admin email is sent; only skip the row.
  //
  // ⚠️ REFUNDS ONLY. A chargeback is not something an admin can initiate — it is a
  // cardholder going to their bank — so the exemption cannot apply to it whatever any
  // flag says. One admin refund used to silence every later CHARGEBACK on that payment
  // forever, because this function is shared by charge.refunded AND
  // charge.dispute.created.
  //
  // TWO independent tests, because each covers the other's race:
  //
  //  1. `refund_source = 'admin'` is the IN-FLIGHT marker. admin-payment-action stamps
  //     it BEFORE calling Stripe precisely because this webhook can arrive before the
  //     function returns. As of 20260814010000 record_refund CLEARS it once the refund
  //     is ledgered, so it now means "in flight", which is all it ever should have
  //     meant. Left permanent, it made a later EXTERNAL refund on the same payment
  //     invisible too.
  //
  //  2. Our ledger already accounts for everything Stripe says was refunded. This is
  //     the self-clearing version of the same statement, and it covers the ordering the
  //     marker cannot: webhook arriving AFTER record_refund committed and cleared the
  //     flag. amount_refunded is cumulative, so `refunded_cents >= amount_refunded`
  //     means there is nothing unledgered to complain about. When Stripe has refunded
  //     MORE than we recorded, something happened outside the console and the row must
  //     be filed — which is the entire point of the control that reads it.
  //
  // What goes dark when this is wrong: the /disputes console page reads only this
  // table, so a human never sees it; ctl_external_reversal_not_ledgered INNER JOINs it;
  // dispute_open_beyond_sla counts its rows; and earner-claim-payment's DISPUTE_OPEN
  // gate would happily settle a booking with a live reversal against it.
  if (kind === 'refund') {
    const row = payment as { refund_source?: string | null; refunded_cents?: number | null } | null;
    const inFlight = row?.refund_source === 'admin';
    const alreadyLedgered = stripeRefundedCents !== null
      && (row?.refunded_cents ?? 0) >= stripeRefundedCents;
    if (inFlight || alreadyLedgered) {
      console.log(
        `recordReversal: skipping dispute row for console refund on ${bookingId} ` +
        `(${inFlight ? 'in flight' : 'already ledgered'})`,
      );
      return bookingId;
    }
  }

  // raised_by is NOT NULL → attribute to the poster (the cardholder who charged back);
  // fall back to the earner if the join is somehow unavailable.
  const { data: bk } = await supabase
    .from('bookings').select('earner_id, job_id').eq('id', bookingId).single();
  let raisedBy = (bk as { earner_id?: string } | null)?.earner_id ?? null;
  const jobId = (bk as { job_id?: string } | null)?.job_id;
  if (jobId) {
    const { data: job } = await supabase.from('jobs').select('poster_id').eq('id', jobId).single();
    raisedBy = (job as { poster_id?: string } | null)?.poster_id ?? raisedBy;
  }
  if (!raisedBy) return bookingId;

  const { data: existing } = await supabase
    .from('disputes').select('id').eq('booking_id', bookingId).ilike('reason', `%${externalId}%`).maybeSingle();
  if (!existing) {
    await supabase.from('disputes').insert({
      booking_id: bookingId,
      raised_by: raisedBy,
      reason: reason.slice(0, 500),
    });
  }
  return bookingId;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Two destinations can point at this same URL with DIFFERENT signing secrets:
  //   • STRIPE_WEBHOOK_SECRET         — the "Your account" destination (payments + identity)
  //   • STRIPE_WEBHOOK_SECRET_CONNECT — an optional "Connected accounts" destination, so
  //     connected-account account.updated events (which a "Your account" scope never
  //     receives) reach the account.updated handler below for reactive demote/promote.
  // We verify against whichever secret matches. The CONNECT secret is optional — if it's
  // unset, only the main destination is accepted (no behavior change).
  const webhookSecrets = [
    Deno.env.get('STRIPE_WEBHOOK_SECRET'),
    Deno.env.get('STRIPE_WEBHOOK_SECRET_CONNECT'),
  ].filter((s): s is string => !!s);

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });

  // Must use raw body string for signature verification
  const body = await req.text();
  let event: Stripe.Event | null = null;
  let lastErr = 'No signing secret matched';
  for (const secret of webhookSecrets) {
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, secret);
      break;
    } catch (err: any) {
      lastErr = err?.message ?? lastErr;
    }
  }
  if (!event) {
    console.error('Webhook signature error:', lastErr);
    return new Response(`Webhook Error: ${lastErr}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;

        // ── This used to credit the earner a number Stripe never collected ────
        //
        // It marked the row captured with NO status predicate and then credited
        // straight off earner_amount_cents, never reading pi.amount_received. Both
        // sibling handlers below ARE status-guarded, with comments explaining why;
        // this one — the only one that moves money — was not.
        //
        // The full split is written at AUTHORIZATION (create-payment-intent:408), so
        // a row carries a full-value split from the moment the hold is placed. Capture
        // the PaymentIntent for a smaller amount anywhere other than our own capture
        // function — the Stripe Dashboard being the obvious one — and this credited the
        // earner the FULL figure regardless of what was actually collected, then latched
        // earnings_credited=true so it could not be re-run.
        //
        // RUNBOOK_MONEY.md §3 has been telling operators "do not capture from the Stripe
        // Dashboard… fix that first" instead of the code refusing to get it wrong.
        //
        // Our own capture path is unaffected: stripe-capture-payment deliberately
        // persists the REDUCED split BEFORE calling Stripe precisely so a fast webhook
        // cannot over-credit, so its rows already reconcile and fall through untouched.
        const { data: row } = await supabase
          .from('payments')
          .select('id, status, amount_cents, fee_cents, earner_amount_cents, earnings_credited')
          .eq('payment_intent_id', pi.id)
          .maybeSingle();

        if (!row) {
          console.error(`stripe-webhook: succeeded for unknown payment_intent ${pi.id}`);
          break;
        }

        const received = typeof pi.amount_received === 'number' ? pi.amount_received : 0;
        const storedSplit = (row.earner_amount_cents ?? 0) + (row.fee_cents ?? 0);

        // Stripe collected something other than what this row claims. Re-derive the
        // split from what actually moved, using the same proportional rule as
        // stripe-capture-payment, BEFORE anything credits the earner.
        if (received > 0 && received !== storedSplit) {
          const authorized = row.amount_cents || 0;
          const pct = authorized > 0 ? Math.min(1, received / authorized) : 1;
          const fee = Math.min(received, Math.round((row.fee_cents ?? 0) * pct));
          await supabase.from('payments')
            .update({ fee_cents: fee, earner_amount_cents: received - fee })
            .eq('id', row.id)
            // Never rewrite a split that has already been paid out on.
            .eq('earnings_credited', false);
          await logServerError('stripe-webhook',
            `partial//external capture on ${pi.id}: Stripe collected ${received} but the row ` +
            `claimed ${storedSplit}. Split re-derived before crediting.`,
            { payment_id: row.id, received, stored: storedSplit }, { fatal: false });
        }

        // Only a not-yet-settled row may become captured. A stale or redelivered
        // succeeded must not resurrect a cancelled or failed payment — the same
        // reasoning the payment_failed and canceled handlers below already apply.
        await supabase.from('payments')
          .update({ status: 'captured', captured_at: new Date().toISOString() })
          .eq('payment_intent_id', pi.id)
          .in('status', ['pending', 'authorized']);

        if (!['pending', 'authorized', 'captured'].includes(row.status)) {
          console.error(
            `stripe-webhook: succeeded arrived for ${pi.id} while the row was '${row.status}' — ` +
            `status left alone, but Stripe has this money. Needs a human.`,
          );
        }

        // Settlement must credit the earner exactly once, no matter which path (this
        // webhook or the capture edge function) observes it first. credit_earnings is
        // atomic + idempotent and requires status='captured', so calling it here is
        // safe — and it now reads a split that matches what Stripe collected.
        await supabase.rpc('credit_earnings', { p_payment_id: row.id });
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        // Status precondition, mirroring payment_intent.canceled below. Stripe
        // delivers at-least-once and retries for up to ~3 days, so a stale or
        // redelivered payment_failed can arrive AFTER the intent succeeded and was
        // captured. Without this guard that late event stamped a settled row
        // 'failed', which makes a paid booking look unpaid to both UIs and to
        // stripe-capture-payment's HOLD_EXPIRED branch. Only a not-yet-settled row
        // can fail.
        await supabase.from('payments')
          .update({ status: 'failed' })
          .eq('payment_intent_id', pi.id)
          .in('status', ['pending', 'authorized']);
        const { data: payment } = await supabase
          .from('payments').select('booking_id').eq('payment_intent_id', pi.id).single();
        if (payment) {
          // Only revert to 'pending' while the booking is still pre-settlement. If
          // the work is already done (completed/verified) this is a CAPTURE failure
          // — don't undo a finished job; leave the status so the poster can retry
          // capture rather than silently resurfacing a completed gig as a request.
          //
          // earner_done is checked too: a 'confirmed' booking where the earner has
          // already marked the work done is performed work that simply has not
          // reached mutual completion yet. Demoting it to 'pending' would strip the
          // confirmation, let sync_slot_taken re-open the slot to a second earner,
          // and erase the state earner-claim-payment settles against — for someone
          // who has actually done the job.
          const { data: bk } = await supabase
            .from('bookings').select('status, earner_done').eq('id', payment.booking_id).single();
          if (bk && ['pending', 'confirmed'].includes(bk.status) && !bk.earner_done) {
            await supabase.from('bookings').update({ status: 'pending' }).eq('id', payment.booking_id);
          }
        }
        break;
      }

      case 'payment_intent.canceled': {
        // A manual-capture authorization was canceled — most importantly, Stripe
        // AUTO-CANCELS an uncaptured hold ~7 days after it's placed. Without this
        // handler the payments row stayed 'authorized' forever, both UIs kept saying
        // "funds held", and a later capture threw a generic 500 with no recovery.
        const pi = event.data.object as Stripe.PaymentIntent;
        // Don't clobber a row that already settled (captured) — only an outstanding
        // authorization can lapse into canceled.
        await supabase.from('payments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('payment_intent_id', pi.id)
          .eq('status', 'authorized');
        const { data: payment } = await supabase
          .from('payments').select('booking_id').eq('payment_intent_id', pi.id).single();
        if (payment) {
          // If the booking hadn't settled yet, send it back to 'pending' so the hold
          // is no longer implied and the poster can re-accept (which places a fresh
          // hold — stripe-create-payment-intent permits a re-hold once the prior
          // payment is cancelled/failed). Leave completed/verified bookings alone;
          // those surface a HOLD_EXPIRED at capture instead.
          //
          // earner_done gates this too. Stripe auto-cancels an uncaptured hold ~7
          // days out, which is well past a typical gig — so this fires precisely on
          // bookings where the work has usually already happened and the poster
          // simply never verified. Demoting such a booking to 'pending' stripped the
          // confirmation, let sync_slot_taken re-open the slot to a second earner,
          // and destroyed the state earner-claim-payment reads — leaving someone who
          // did the work with a gig that looks like an unaccepted request. Leave it
          // 'confirmed' instead: the lapsed hold surfaces as HOLD_EXPIRED at capture,
          // which is a recoverable, visible state that support can settle from.
          const { data: bk } = await supabase
            .from('bookings').select('status, earner_done').eq('id', payment.booking_id).single();
          if (bk && bk.status === 'confirmed' && !bk.earner_done) {
            await supabase.from('bookings').update({ status: 'pending' }).eq('id', payment.booking_id);
          }

          // A hold that lapses on work ALREADY PERFORMED is an unpaid worker, and it
          // was previously silent — nobody was told, on either side.
          //
          // This is the visible half of the known architectural gap: the hold ages
          // from ACCEPT time and Stripe voids it ~7 days later, so a gig scheduled
          // more than a week after acceptance has its escrow die before the work is
          // even due. earner-claim-payment gained a second anchor that recovers the
          // 4-6 day window, but beyond that there is genuinely nothing left to
          // capture. Re-authorizing closer to the gig is the real fix and is a
          // payments-architecture change.
          //
          // Until then this must not fail silently. Page a human with the booking id
          // so support can settle it manually — Stripe still holds the PI metadata
          // (booking_id, job_id, earner_id, poster_id) needed to reconcile, and the
          // booking row now survives (it is no longer demoted), so there is a record
          // to act on. Best-effort: emailAdmin never throws, so a Resend outage cannot
          // wedge the webhook into a Stripe retry loop.
          if (bk && bk.earner_done && ['confirmed', 'completed'].includes(bk.status)) {
            await emailAdmin(
              `Escrow hold expired on completed work — booking ${payment.booking_id}`,
              `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;">
                 <p><strong>The card hold expired before this booking was paid out.</strong></p>
                 <p>The earner marked this job done, so work was almost certainly performed
                    and there is now nothing left to capture.</p>
                 <p>Booking: <code>${esc(payment.booking_id)}</code><br/>
                    PaymentIntent: <code>${esc(pi.id)}</code><br/>
                    Booking status: <code>${esc(bk.status)}</code></p>
                 <p>Settle this manually: the PaymentIntent metadata carries booking_id,
                    job_id, earner_id and poster_id.</p>
               </div>`,
            );
          }
        }
        break;
      }

      case 'account.updated': {
        // Earner's Connect account capability changed. Track it BOTH ways: if Stripe
        // later restricts/deauthorizes the account (loses charges/payouts), demote
        // onboarded to false so new escrow holds + tips stop targeting an account
        // that can no longer receive funds.
        const account = event.data.object as Stripe.Account;
        const fullyOnboarded = !!(
          account.details_submitted &&
          account.charges_enabled &&
          account.payouts_enabled
        );
        await supabase.from('stripe_accounts')
          .update({ onboarded: fullyOnboarded })
          .eq('account_id', account.id);
        break;
      }

      // ── Payouts to the earner's bank (CONNECTED-ACCOUNT events) ────────────
      // The last leg of the money, and the only one the app could not describe.
      // Capture is a destination charge, so funds reach the earner's Connect account
      // at capture; Stripe then pays out to their bank on that account's schedule.
      // Without these events "when does it hit my bank" had no answer but a shrug.
      //
      // These arrive on the CONNECTED-ACCOUNT webhook destination, so `event.account`
      // is the acct_… they belong to — never the platform. That field is what maps a
      // payout to a user; the payout object itself carries no user identity.
      case 'payout.created':
      case 'payout.updated':
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.canceled': {
        const payout = event.data.object as Stripe.Payout;
        const acct = event.account;
        if (!acct) {
          // A payout on the PLATFORM account is our own settlement, not an earner's.
          console.log('stripe-webhook: platform payout, ignoring', payout.id);
          break;
        }

        // Resolve the earner from the connected account. Best-effort: an unmapped
        // account still gets its payout recorded (user_id null) rather than dropped,
        // so the row is there to reconcile instead of the event being lost.
        const { data: acctRow } = await supabase
          .from('stripe_accounts').select('user_id').eq('account_id', acct).maybeSingle();

        // arrival_date is a UNIX SECONDS field: estimated on created, actual on paid.
        const arrival = typeof payout.arrival_date === 'number'
          ? new Date(payout.arrival_date * 1000).toISOString()
          : null;

        const { error: poErr } = await supabase.from('stripe_payouts').upsert({
          payout_id: payout.id,
          account_id: acct,
          user_id: acctRow?.user_id ?? null,
          amount_cents: payout.amount,
          currency: payout.currency ?? 'usd',
          status: payout.status,
          method: payout.method ?? null,
          arrival_date: arrival,
          failure_code: payout.failure_code ?? null,
          failure_message: payout.failure_message ?? null,
          // The ordering key. Stripe does NOT guarantee delivery order and redelivers
          // on any non-2xx, so a replayed payout.created can arrive after payout.paid.
          // Without this the upsert would revert the row to pending and swap the real
          // arrival date back to the estimate — after the earner was already told it
          // landed. guard_stripe_payout_ordering drops the stale write, but only
          // because this field tells it which write is stale.
          last_event_at: new Date(event.created * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'payout_id' });
        if (poErr) console.error('stripe-webhook: payout upsert failed', poErr);

        // Tell them when it actually lands, and when it does not. These are the two
        // moments an earner wants to hear from us; everything between is noise, so
        // pending/in_transit updates are recorded silently.
        if (acctRow?.user_id && (event.type === 'payout.paid' || event.type === 'payout.failed')) {
          const paid = event.type === 'payout.paid';
          try {
            await supabase.from('notifications').insert({
              user_id: acctRow.user_id,
              type: 'payment',
              title: paid ? 'Money landed in your bank' : 'A payout to your bank failed',
              body: paid
                ? `$${(payout.amount / 100).toFixed(2)} has arrived.`
                : `$${(payout.amount / 100).toFixed(2)} could not be deposited. Check your payout account details.`,
              data: { type: 'payment', tab: 'ProfileTab' },
            });
          } catch (e) {
            console.error('stripe-webhook: payout notification failed', e);
          }
        }
        break;
      }

      case 'charge.dispute.created': {
        // H12: a (possibly stolen-card) chargeback. Money is being clawed back from
        // the platform while the earner may already be paid out. Record it as an open
        // dispute on the booking — which suppresses any further auto-capture — and page
        // the admin so a human can freeze/recover before the live-key cutover turns
        // this into a real loss. Idempotent (Stripe redelivers).
        const dispute = event.data.object as Stripe.Dispute;
        const piId = typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id ?? null;
        const amount = ((dispute.amount ?? 0) / 100).toFixed(2);
        const bookingId = await recordReversal(
          supabase, piId, dispute.id,
          `Stripe chargeback ${dispute.id} (${dispute.reason ?? 'unknown'}, ${dispute.currency ?? 'usd'} ${amount})`,
          'chargeback',
        );
        await emailAdmin(
          `⚠️ Chargeback opened: ${dispute.currency ?? 'usd'} ${amount}`,
          `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;">
            <p style="font-size:16px;"><strong>A card dispute (chargeback) was opened.</strong></p>
            <p><strong>Amount:</strong> ${esc((dispute.currency ?? 'usd').toUpperCase())} ${esc(amount)}</p>
            <p><strong>Reason:</strong> ${esc(String(dispute.reason ?? 'unknown'))}</p>
            <p><strong>Booking:</strong> ${bookingId ? esc(bookingId) : 'not matched — investigate in Stripe'}</p>
            <p style="color:#6B6482;font-size:12px;">Dispute ${esc(dispute.id)}${piId ? ` · PI ${esc(piId)}` : ''}. The booking is flagged (auto-settlement suppressed); review and respond in Stripe.</p>
          </div>`,
        );
        break;
      }

      case 'charge.refunded': {
        // A charge was refunded (full or partial) — the poster's money went back.
        // Record it against the booking and alert the admin so payout/ledger can be
        // reconciled. Idempotent per charge id.
        const charge = event.data.object as Stripe.Charge;
        const piId = typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id ?? null;
        const refunded = ((charge.amount_refunded ?? 0) / 100).toFixed(2);
        const bookingId = await recordReversal(
          supabase, piId, charge.id,
          `Stripe refund on charge ${charge.id} (${charge.currency ?? 'usd'} ${refunded} refunded)`,
          'refund',
          typeof charge.amount_refunded === 'number' ? charge.amount_refunded : null,
        );
        await emailAdmin(
          `Refund processed: ${charge.currency ?? 'usd'} ${refunded}`,
          `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;">
            <p style="font-size:16px;"><strong>A charge was refunded.</strong></p>
            <p><strong>Refunded:</strong> ${esc((charge.currency ?? 'usd').toUpperCase())} ${esc(refunded)}</p>
            <p><strong>Booking:</strong> ${bookingId ? esc(bookingId) : 'not matched — investigate in Stripe'}</p>
            <p style="color:#6B6482;font-size:12px;">Charge ${esc(charge.id)}${piId ? ` · PI ${esc(piId)}` : ''}. Reconcile the earner payout/ledger if already credited.</p>
          </div>`,
        );
        break;
      }

      case 'identity.verification_session.verified': {
        // Stripe confirmed the user's government ID + selfie match.
        const vs = event.data.object as Stripe.Identity.VerificationSession;
        const uid = vs.metadata?.supabase_uid;
        if (uid) {
          await supabase.from('profiles')
            .update({ verified: true, id_verification_status: 'verified' })
            .eq('id', uid);
        }
        break;
      }

      case 'identity.verification_session.requires_input': {
        // Verification could not be completed (e.g. unreadable document).
        const vs = event.data.object as Stripe.Identity.VerificationSession;
        const uid = vs.metadata?.supabase_uid;
        if (uid) {
          await supabase.from('profiles')
            .update({ id_verification_status: 'rejected' })
            .eq('id', uid);
        }
        break;
      }

      case 'identity.verification_session.canceled': {
        // User abandoned the flow — reset so they can try again.
        const vs = event.data.object as Stripe.Identity.VerificationSession;
        const uid = vs.metadata?.supabase_uid;
        if (uid) {
          await supabase.from('profiles')
            .update({ id_verification_status: 'none', stripe_identity_session_id: null })
            .eq('id', uid);
        }
        break;
      }

      default:
        // Unhandled events — no-op
        break;
    }
  } catch (err: any) {
    // Log internals server-side only; never leak exception text to the caller.
    console.error('Webhook handler error:', err);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
