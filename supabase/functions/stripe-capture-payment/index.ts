// Captures a previously-authorized PaymentIntent after both parties verify job completion.
// Stripe automatically transfers earner_amount to their Connect account on capture.
//
// ── A REDUCTION IS NOW A PROPOSAL, NOT A SETTLEMENT (2026-09-09) ────────────
//
// This function used to capture the reduced amount inside the poster's button press and
// write the `disputes` row about eighty lines later, so the record documented a decision
// already executed and Stripe had already released the remainder to the poster. Nothing
// here can pay an earner MORE afterwards — stripe.transfers.create appears nowhere — so
// the earner's reply, when it finally existed, would have been an appeal against a
// completed act.
//
// Now: pct < 1 leaves the authorization standing and records a PROPOSAL the earner has
// 48 hours to answer. settle-disputes captures later, on the hourly sweep, at whatever
// public.dispute_settlement_pct() decides. A full-pay verification is untouched and
// still captures synchronously in this request.
//
// The money arithmetic itself moved to _shared/settleEscrow.ts so this function and the
// settler share ONE copy of it.
import Stripe from 'npm:stripe@22.5.0';
import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { logServerError, errMessage } from '../_shared/logError.ts';
import { one } from '../_shared/pgrest.ts';
import { settleEscrow, setSettlementFnName } from '../_shared/settleEscrow.ts';

setSettlementFnName('stripe-capture-payment');

// Stripe auto-cancels an uncaptured manual PaymentIntent at about seven days. A
// response window shorter than this leaves no room for the earner to answer AND for the
// settler to capture afterwards, so below it we decline to hold at all.
const HOLD_LIFE_HOURS = 7 * 24;
// ── DERIVED FROM BRANCH 4, NOT FROM THE HOLD ────────────────────────────────────────
//
// The authorization dies at 7 days, but a CONTESTED case is decided long before that:
// dispute_settlement_pct branch 4 captures it in FULL at held_since + 5 days. 36 hours of
// runway therefore admitted a proposal until held_since + 5.5 days — already PAST the
// moment the case would be auto-decided. Made there and contested, it was captured at the
// next hourly sweep with nobody having read it, and
// ctl_dispute_contested_unadjudicated filed its "you have two days" finding on the same
// sweep that took the money. The promise both clients make — that a person reads the
// case — had no time left to be kept.
//
// 60 = the 48 hours branch 4 leaves, plus the same 12 hours of margin dispute_set_defaults
// uses for the hourly sweep and a retry. Below it, NO_ROOM_TO_HOLD captures in full and
// says so plainly, which is the honest answer for a report this late and is refundable.
const AUTO_CAPTURE_DAYS = 5;      // dispute_settlement_pct branch 4
const SETTLE_MARGIN_HOURS = 12;   // dispute_set_defaults' own margin
const MIN_RUNWAY_HOURS = (7 - AUTO_CAPTURE_DAYS) * 24 + SETTLE_MARGIN_HOURS;


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

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

    // Optional pct (partial capture for a dispute) releases the remainder of the
    // hold back to the poster. Policy: a reduced payout is allowed ONLY with a stated
    // reason (recorded below as an audit trail) and is FLOORED at 50% — reaching the
    // verify step requires the poster's own mark-done, so the worker earned at least
    // half; a genuine no-show should be cancelled (full refund), not verified at ~0%.
    // This prevents a poster from capturing completed work at a trivial amount.
    const { bookingId, pct, disputeReason, disputePhotos } = await req.json();
    errBookingId = typeof bookingId === 'string' ? bookingId : null;
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    const wantsPartial = typeof pct === 'number' && pct < 1;
    if (wantsPartial && (!disputeReason || !String(disputeReason).trim())) {
      return json({
        error: 'DISPUTE_REASON_REQUIRED',
        message: 'To release less than the full amount, describe the problem so it can be recorded.',
      }, 400);
    }
    // Hard floor at 50%; clamp to [0.5, 1]. Full capture when pct is absent/>=1.
    const capturePctFinal = wantsPartial ? Math.min(1, Math.max(0.5, pct)) : 1;

    // Authorization (IDOR guard): capture releases escrow to the earner, so only
    // the poster who owns this booking's job may trigger it, and only once the
    // work is done. Without this any signed-in user could settle others' bookings.
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, status, earner_id, job_id, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'Booking is not ready to capture' }, 409);
    }


    // A booking's ONE live adjustment proposal, if it has one.
    //
    // Scoped to the LIVE proposal, not to "any dispute on this booking". A booking can
    // legitimately carry others — NO_ROOM_TO_HOLD files a pre-settled row (pct_paid set)
    // and stripe-webhook's recordReversal files a bare refund/chargeback row (no
    // proposed_pct) — and an unscoped `.maybeSingle()` returns {data: null, error} the
    // moment there are two of anything.
    //
    // HOISTED OUT OF THE PARTIAL BRANCH, deliberately. It used to be declared after the
    // runway check and inside `if (wantsPartial)`, so the two other ways into this
    // function could not see a standing proposal at all — and both of them captured the
    // full hold over one. See the two blocks that consult it below.
    const liveProposal = () =>
      supabase.from('disputes').select('id, settle_after, proposed_pct')
        .eq('booking_id', bookingId).is('pct_paid', null).not('proposed_pct', 'is', null)
        .maybeSingle();

    // ── A reduction becomes a PROPOSAL ─────────────────────────────────────────
    //
    // Nothing is captured here. The authorization stays live so it is still the remedy
    // fund when somebody decides, and the booking stays `completed` — guard_bookings_write
    // forbids completed→verified without a captured payment, and
    // ctl_settled_without_captured_payment is CRITICAL on exactly that shape, so the two
    // agree by construction.
    if (wantsPartial) {
      const { data: payRow, error: payErr } = await supabase
        .from('payments')
        .select('id, status, created_at, authorized_at, amount_cents')
        .eq('booking_id', bookingId)
        .single();
      if (payErr || !payRow) return json({ error: 'Payment not found' }, 404);
      if (payRow.status === 'captured') {
        return json({
          error: 'ALREADY_SETTLED',
          message: 'This booking has already been paid, so it can no longer be adjusted. Contact support for a refund.',
        }, 409);
      }

      // ── HAS THIS ALREADY BEEN PROPOSED? ASKED FIRST, BEFORE THE RUNWAY BRANCH ──
      //
      // This read used to sit BELOW the runway check, so inside the hold's last 36
      // hours a second "report a problem" never learned a proposal was already
      // standing: NO_ROOM_TO_HOLD fired instead and captured the FULL amount, quietly
      // converting the poster's own 60% reduction into 100%. Its evidence row carries
      // no proposed_pct, so `disputes_one_live_proposal_per_booking` did not collide
      // either — a second row went in and the first was orphaned, still unsettled,
      // still paging ctl_dispute_settlement_overdue. ADJUSTMENT_ALREADY_PROPOSED exists
      // to say "a second report does not replace the first"; this ordering was the one
      // path where a second report replaced the first with the maximum.
      //
      // Nothing is lost by answering here: `dispute_set_defaults` derives settle_after
      // from the hold, so a standing proposal is ALWAYS due at least 12h before the
      // authorization dies and the hourly settler was always going to reach it in time.
      const { data: existing } = await liveProposal();
      if (existing) {
        // ── A RETRY IS NOT A REVISION ──────────────────────────────────────
        //
        // This returned a bare success, so both clients printed the percentage the
        // POSTER HAD JUST TYPED — `${Math.round(pct * 100)}% is paid automatically`
        // (JobsContext.js:972, web/lib/jobs.tsx:1019) — while the stored row kept the
        // FIRST one and the earner was notified of that. Reopening the sheet is easy on
        // the website, where /hiring re-offers "Verify & rate" on any `completed`
        // booking with no dispute lookup at all, and a proposal deliberately leaves the
        // booking `completed`. So: propose 50% on Tuesday, soften to 90% on Wednesday,
        // and the poster is told 90% while the earner is paid 50% — or the reverse, and
        // the poster overpays believing they had reduced it.
        //
        // Same figure, same clock: an idempotent retry, answered as before. DIFFERENT
        // figure: refused, naming what is actually on the record, because silently
        // keeping one number while reporting another is the whole defect.
        const storedPct = Number(existing.proposed_pct);
        const askedPct = Math.round(capturePctFinal * 100);
        if (Number.isFinite(storedPct) && storedPct !== askedPct) {
          return json({
            error: 'ADJUSTMENT_ALREADY_PROPOSED',
            proposedPct: storedPct,
            settleAfter: existing.settle_after,
            message:
              `You already asked to pay ${storedPct}% on this gig and the worker has been `
              + `told. That is what will be paid unless they reply. To change it, contact `
              + `support — a second report does not replace the first.`,
          }, 409);
        }
        return json({
          success: true,
          adjustment: 'proposed',
          // The RECORDED figure, so a client can never narrate a number the row does not
          // hold. Both clients render this in preference to what the user typed.
          proposedPct: Number.isFinite(storedPct) ? storedPct : askedPct,
          settleAfter: existing.settle_after,
        });
      }

      // ── Runway ───────────────────────────────────────────────────────────────
      // The hold was minted when the poster ACCEPTED, not when the work was done, so a
      // gig booked on Monday and verified on Saturday may have almost none of its seven
      // days left. With too little runway there is no room for a fair window, and a
      // lapsed authorization pays NOBODY — strictly worse for the earner than any
      // outcome the dispute could reach. So capture in FULL, which is the one direction
      // this codebase can walk back (admin-payment-action refund), and say so plainly.
      // authorized_at, NOT created_at. created_at is the FIRST hold ever placed on this
      // booking; stripe-create-payment-intent upserts on booking_id and deliberately
      // leaves it alone on a recovery re-hold, writing authorized_at instead
      // (20260806150000). Reading created_at judged a fresh hold by a dead clock and
      // captured in full on a booking with six days of runway.
      const heldSinceIso = payRow.authorized_at ?? payRow.created_at;
      const heldSince = heldSinceIso ? new Date(heldSinceIso).getTime() : Date.now();
      const runwayHours = HOLD_LIFE_HOURS - (Date.now() - heldSince) / 3_600_000;
      if (runwayHours < MIN_RUNWAY_HOURS) {
        // FILE THE RECORD FIRST. This branch used to return before the insert was
        // reachable, so the poster's reason and up to six uploaded photos were
        // discarded: nothing on /disputes, nothing for support, and no way to review a
        // refund request against what was actually claimed. The row documents a decision
        // the CLOCK made rather than one anybody has to answer — so it ends up carrying
        // pct_paid and a resolution note, but only once the capture has succeeded. See
        // the block below for why the stamp cannot come first.
        const photosNow = Array.isArray(disputePhotos)
          ? disputePhotos
              .filter((p: unknown): p is string => typeof p === 'string')
              .filter((p) => p.startsWith(`${user.id}/`))
              .slice(0, 6)
          : [];
        // ── EVIDENCE FIRST, SETTLEMENT ONLY AFTER THE MONEY MOVES ───────────
        //
        // The row goes in with the poster's reason and photos and NOTHING ELSE. It used
        // to be pre-stamped `pct_paid: 100, settled_at, resolved_at, status:'rejected'`
        // BEFORE the capture — and this branch is entered only when the hold is inside
        // its last 36 hours, which is exactly when settleEscrow is most likely to
        // refuse: HOLD_EXPIRED on a payment the webhook has already marked cancelled, or
        // EARNER_PAYOUTS_DISABLED on a Connect account Stripe restricted in the meantime.
        // On that path zero cents moved and the row permanently claimed the earner had
        // been paid in full — and it BLINDED the one control that should have caught it,
        // because dispute_settlement_pct opens with `if d.pct_paid is not null then
        // return null`, so ctl_dispute_settlement_overdue (critical) could never see it.
        //
        // proposed_pct is withheld too, deliberately: setting it arms
        // dispute_set_defaults' clock and fires dispute_notify_respondent, which would
        // tell the earner they have until X to answer a reduction we are about to
        // abandon. Both are stamped below, once the capture has actually succeeded.
        const { data: noRoomRow, error: recErr } = await supabase.from('disputes').insert({
          booking_id: bookingId,
          raised_by: user.id,
          reason: String(disputeReason).trim().slice(0, 500),
          photos: photosNow,
        }).select('id').single();
        if (recErr || !noRoomRow) {
          await logServerError('stripe-capture-payment',
            `could not record the no-runway adjustment for booking ${bookingId}: ${recErr?.message ?? 'no row'}`,
            { booking_id: bookingId }, { fatal: true });
        }
        const settled = await settleEscrow(stripe, supabase, {
          bookingId, earnerId: booking.earner_id, capturePct: 1,
        });
        if (!settled.ok) {
          // The row stays UNSETTLED on purpose. The poster's evidence is kept, the case
          // is open on /disputes, resolved_at is null so earner-claim-payment still
          // refuses, and nothing anywhere claims money moved that did not.
          return json({ error: settled.error, message: settled.message }, settled.status);
        }
        if (noRoomRow) {
          const { error: stampErr } = await supabase.from('disputes').update({
            proposed_pct: Math.round(capturePctFinal * 100),
            pct_paid: 100,
            settled_at: new Date().toISOString(),
            resolved_at: new Date().toISOString(),
            status: 'rejected',
            resolution_note:
              'Captured in full: the card authorization was too close to expiring to hold '
              + 'this for a reply. The reduction was not applied. A refund can still be issued.',
          }).eq('id', noRoomRow.id).is('pct_paid', null);
          if (stampErr) {
            // The money HAS moved; this is bookkeeping. Loud, because a settled capture
            // whose dispute row still reads open pages ctl_dispute_settlement_overdue.
            await logServerError('stripe-capture-payment',
              `captured in full on ${bookingId} but could not stamp dispute ${noRoomRow.id}: ${stampErr.message}`,
              { booking_id: bookingId }, { fatal: true });
          }
        }
        await logServerError('stripe-capture-payment',
          `no runway to hold booking ${bookingId} for a response (${Math.round(runwayHours)}h left) — captured in full`,
          { booking_id: bookingId }, { fatal: false });
        return json({
          success: true,
          capturedInFull: true,
          reason: 'NO_ROOM_TO_HOLD',
          message: 'The card hold was too close to expiring to pause this, so it was paid in full. Contact support and a refund can still be issued.',
        });
      }

      // Only the caller's OWN storage paths. A poster who could name any path would pull
      // another user's private photos into a record the earner and support both read.
      const photos = Array.isArray(disputePhotos)
        ? disputePhotos
            .filter((p: unknown): p is string => typeof p === 'string')
            .filter((p) => p.startsWith(`${user.id}/`))
            .slice(0, 6)
        : [];

      const { data: created, error: dErr } = await supabase.from('disputes').insert({
        booking_id: bookingId,
        raised_by: user.id,
        reason: String(disputeReason).trim().slice(0, 500),
        proposed_pct: Math.round(capturePctFinal * 100),
        // pct_paid stays NULL — nothing has been collected. The console and the controls
        // both read it as "what was actually paid", and conflating the two is what made
        // the old row look like a settlement.
        photos,
      }).select('id, settle_after').single();
      // CHECKED, unlike the old insert: a failed write used to leave a reduced payout
      // with no audit trail anywhere, invisible to /disputes and to every control.
      //
      // 23505 is the one failure that is not a failure. `disputes_one_live_proposal_per_booking`
      // (20260909060000) is what actually makes this idempotent — the SELECT above is a
      // fast path, not the guard — so a concurrent double-tap loses the insert race and
      // must read back the winner rather than telling the poster nothing was recorded.
      // Reporting a 500 there would be the worst answer available: the proposal DID land,
      // the earner is already on the clock, and the poster would report it again.
      if (dErr?.code === '23505') {
        const { data: winner } = await liveProposal();
        if (winner) {
          // The winner's figure, not ours — same rule as the fast path above. Losing the
          // insert race means somebody else's percentage is what the earner was told.
          return json({
            success: true,
            adjustment: 'proposed',
            proposedPct: Number(winner.proposed_pct),
            settleAfter: winner.settle_after,
          });
        }
      }
      if (dErr || !created) {
        await logServerError('stripe-capture-payment',
          `dispute proposal insert failed for booking ${bookingId}: ${dErr?.message ?? 'no row'}`,
          { booking_id: bookingId }, { fatal: true });
        return json({ error: 'Could not record the problem. Nothing has been paid — please try again.' }, 500);
      }

      return json({
        success: true,
        adjustment: 'proposed',
        proposedPct: Math.round(capturePctFinal * 100),
        settleAfter: created.settle_after,
      });
    }

    // ── Full pay ──────────────────────────────────────────────────────────────
    //
    // A STANDING PROPOSAL IS WITHDRAWN HERE, NOT IGNORED.
    //
    // This path did no dispute lookup at all: `wantsPartial` returns above, so everything
    // reaching it went straight to a 100% capture. But a proposal deliberately leaves the
    // booking `completed`, and web /hiring re-offers "Verify & rate" on every `completed`
    // booking — so the poster could reopen the sheet and pay in full over their own live
    // reduction in one tap, bypassing ADJUSTMENT_ALREADY_PROPOSED entirely.
    //
    // The earner is paid MORE, so this is not underpayment and REFUSING would be wrong:
    // withdrawing a reduction and paying the worker everything is a generous act and
    // should not need a support ticket. What was wrong is that the row was left behind —
    // `pct_paid` null forever, ctl_dispute_settlement_overdue (critical) paging on it,
    // settle-disputes retrying a capture against an already-captured PaymentIntent every
    // hour, and the earner still holding a 48-hour deadline to answer a closed case.
    //
    // So: capture, then close the proposal and tell them.
    const { data: standingProposal } = await liveProposal();

    const settled = await settleEscrow(stripe, supabase, {
      bookingId, earnerId: booking.earner_id, capturePct: 1,
    });
    if (!settled.ok) return json({ error: settled.error, message: settled.message }, settled.status);
    const { settledPct, capturedGigCents } = settled;

    if (standingProposal) {
      // Money first, record second — the ordering NO_ROOM_TO_HOLD was corrected to. A row
      // must never claim a settlement that did not happen.
      const { error: closeErr } = await supabase.from('disputes').update({
        pct_paid: 100,
        settled_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
        status: 'resolved',
        resolution_note:
          `Paid in full. The person who reported the problem chose to release the whole `
          + `amount instead of the ${standingProposal.proposed_pct}% they had proposed, so `
          + `the adjustment was withdrawn and no reply was needed.`,
      }).eq('id', standingProposal.id).is('pct_paid', null);
      if (closeErr) {
        // Loud: the capture HAPPENED, so a row still reading open is a critical control
        // firing forever on a gig that is settled and correct.
        await logServerError('stripe-capture-payment',
          `captured in full on ${bookingId} but could not close proposal ${standingProposal.id}: ${closeErr.message}`,
          { booking_id: bookingId }, { fatal: true });
      } else {
        // The earner was told they had until a deadline to answer. Close that loop —
        // saying nothing leaves a countdown running against a case that is over.
        await supabase.from('notifications').insert({
          user_id: booking.earner_id,
          type: 'dispute',
          title: 'They withdrew the adjustment',
          body: `You have been paid in full for this gig. There is nothing left to reply to.`,
          job_id: booking.job_id,
          data: { dispute_id: standingProposal.id, booking_id: bookingId },
        });
      }
    }


    // A dispute row is no longer written here, and cannot be: `wantsPartial` returns
    // above, so anything reaching this line captured in FULL. The block that used to sit
    // here — insert a dispute when the LEDGER said a reduced capture had happened — was
    // the audit trail for a settlement that had already executed. Under the proposal
    // flow the row exists BEFORE any money moves, written by the branch above, and
    // settle-disputes stamps pct_paid on that same row when it captures. Two writers,
    // one row, and the earner is on it from the start.
    void settledPct;
    void capturedGigCents;

    return json({ success: true });
  } catch (err: any) {
    console.error('stripe-capture-payment:', err);
    // Land it where an operator will actually see it (/errors in the admin
    // console). This used to stop at console.error, so a money-path failure
    // was invisible unless someone was tailing Supabase function logs.
    await logServerError('stripe-capture-payment', `Escrow capture failed — the poster tried to pay and could not: ${errMessage(err)}`,
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
