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
const MIN_RUNWAY_HOURS = 36;


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
      .select('id, status, earner_id, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .single();
    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!['completed', 'verified'].includes(booking.status)) {
      return json({ error: 'Booking is not ready to capture' }, 409);
    }


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
        .select('id, status, created_at, amount_cents')
        .eq('booking_id', bookingId)
        .single();
      if (payErr || !payRow) return json({ error: 'Payment not found' }, 404);
      if (payRow.status === 'captured') {
        return json({
          error: 'ALREADY_SETTLED',
          message: 'This booking has already been paid, so it can no longer be adjusted. Contact support for a refund.',
        }, 409);
      }

      // ── Runway ───────────────────────────────────────────────────────────────
      // The hold was minted when the poster ACCEPTED, not when the work was done, so a
      // gig booked on Monday and verified on Saturday may have almost none of its seven
      // days left. With too little runway there is no room for a fair window, and a
      // lapsed authorization pays NOBODY — strictly worse for the earner than any
      // outcome the dispute could reach. So capture in FULL, which is the one direction
      // this codebase can walk back (admin-payment-action refund), and say so plainly.
      const heldSince = payRow.created_at ? new Date(payRow.created_at).getTime() : Date.now();
      const runwayHours = HOLD_LIFE_HOURS - (Date.now() - heldSince) / 3_600_000;
      if (runwayHours < MIN_RUNWAY_HOURS) {
        const settled = await settleEscrow(stripe, supabase, {
          bookingId, earnerId: booking.earner_id, capturePct: 1,
        });
        if (!settled.ok) return json({ error: settled.error, message: settled.message }, settled.status);
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

      // Idempotent per booking: a retry must not mint a second proposal, and must not
      // reset the clock the earner is already running against.
      const { data: existing } = await supabase
        .from('disputes').select('id, settle_after').eq('booking_id', bookingId).maybeSingle();
      if (existing) {
        return json({ success: true, adjustment: 'proposed', settleAfter: existing.settle_after });
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
      if (dErr || !created) {
        await logServerError('stripe-capture-payment',
          `dispute proposal insert failed for booking ${bookingId}: ${dErr?.message ?? 'no row'}`,
          { booking_id: bookingId }, { fatal: true });
        return json({ error: 'Could not record the problem. Nothing has been paid — please try again.' }, 500);
      }

      return json({ success: true, adjustment: 'proposed', settleAfter: created.settle_after });
    }

    // ── Full pay: unchanged, still synchronous ────────────────────────────────
    const settled = await settleEscrow(stripe, supabase, {
      bookingId, earnerId: booking.earner_id, capturePct: 1,
    });
    if (!settled.ok) return json({ error: settled.error, message: settled.message }, settled.status);
    const { settledPct, capturedGigCents } = settled;


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
