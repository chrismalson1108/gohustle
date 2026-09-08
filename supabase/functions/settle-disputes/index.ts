// Pays out disputes whose outcome is decided, on the hourly control sweep.
//
// Holding the escrow instead of capturing on the poster's tap is what makes the earner's
// reply meaningful — and it makes THIS the only thing that pays a held gig. That is a new
// single point of silence, and this repo already has the cautionary tale:
// expire_stale_pending_bookings shipped without claiming service_role, raised inside the
// sweep's own `exception when others then raise warning`, and never once ran from cron
// for three weeks while the console's "Run sweep now" — which does not reach it —
// reported success.
//
// So: ctl_dispute_settlement_overdue is CRITICAL, every failure lands in client_errors
// (where ctl_edge_errors_burst pages at three), and this function never swallows an
// error into a success. The failure mode it exists to prevent is not a reduced payout —
// it is the Stripe authorization lapsing at about seven days, after which the earner is
// paid NOTHING and no code here can pay them.
//
// The outcome is NOT decided here. public.dispute_settlement_pct() is the one definition
// of who gets what, and this function asks it. Deciding again in TypeScript would be a
// second copy of the rule that the console, the controls and the probe all read.
//
// verify_jwt = false (see supabase/config.toml): dispatched by controls_sweep_and_page
// via pg_net with the x-controls-secret shared secret, never by a user.
import Stripe from 'npm:stripe@22.5.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';
import { logServerError } from '../_shared/logError.ts';
import { settleEscrow, setSettlementFnName } from '../_shared/settleEscrow.ts';

setSettlementFnName('settle-disputes');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-controls-secret',
};

const FN = 'settle-disputes';
// A sweep runs hourly; a batch bigger than this means something is very wrong and the
// right answer is to page rather than to grind.
const MAX_PER_RUN = 50;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // App-level auth: the same shared secret the sweep already sends to controls-alert
    // and reconcile-stripe, read from app_flags rather than a GUC — a GUC is invisible,
    // needs superuser, and cannot be read back, which is how trg_notify_safety_report sat
    // dead for four weeks. Fail CLOSED when it is not configured: never an open endpoint
    // that moves money.
    const { data: cfg } = await supabase.rpc('alert_config', { p_key: 'controls_alert' });
    const expected = (cfg as { secret?: string } | null)?.secret ?? '';
    if (!expected) {
      await logServerError(FN, 'controls secret is not configured — refusing to settle', {}, { fatal: true });
      return json({ error: 'not_configured' }, 503);
    }
    if (req.headers.get('x-controls-secret') !== expected) return json({ error: 'forbidden' }, 403);

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2026-07-29.dahlia' });

    // Unsettled disputes, oldest first. The outcome for each is asked of the database.
    const { data: rows, error: listErr } = await supabase
      .from('disputes')
      .select('id, booking_id, proposed_pct, resolution_pct, response_stance, responded_at, settle_after')
      .is('pct_paid', null)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);
    if (listErr) {
      await logServerError(FN, `could not list disputes: ${listErr.message}`, {}, { fatal: true });
      return json({ error: 'list_failed' }, 500);
    }

    const settled: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const d of rows ?? []) {
     // ── PER-DISPUTE ISOLATION ─────────────────────────────────────────────
     //
     // Every failure inside settleEscrow is a RETURNED {ok:false} that the loop handles
     // with `continue` — except the two `stripe.paymentIntents.capture` calls, which are
     // unguarded and THROW. A thrown SDK error unwound past this loop to the single outer
     // catch, so one poisoned dispute aborted the entire batch and D2…D50 were never
     // reached. The condition is deterministic (a voided PaymentIntent whose row still
     // reads 'authorized' because the canceled webhook was missed — the exact state
     // reconcile-stripe exists for), so it repeated on every sweep, for ever.
     //
     // This function is, by its own header, the only thing that pays a held gig. One
     // stuck row therefore starved every other earner on the platform until their own
     // authorizations lapsed at ~7 days — and the outer catch logs with an EMPTY context,
     // so /errors named neither the dispute nor the booking that did it.
     //
     // Oldest-first ordering guarantees the poisoned row is processed FIRST.
     try {
      // ONE definition of the outcome. Null means not due yet.
      const { data: pctRaw, error: pctErr } = await supabase.rpc('dispute_due_pct', { p_dispute: d.id });
      if (pctErr) {
        await logServerError(FN, `outcome lookup failed for dispute ${d.id}: ${pctErr.message}`,
          { dispute_id: d.id, booking_id: d.booking_id }, { fatal: true });
        failed.push(d.id);
        continue;
      }
      if (pctRaw === null || pctRaw === undefined) { skipped.push(d.id); continue; }
      const pct = Number(pctRaw);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        await logServerError(FN, `outcome for dispute ${d.id} was ${String(pctRaw)}, refusing to settle`,
          { dispute_id: d.id }, { fatal: true });
        failed.push(d.id);
        continue;
      }

      // The earner, and the fact that this booking is still settleable at all.
      const { data: booking } = await supabase
        .from('bookings').select('id, status, earner_id').eq('id', d.booking_id).maybeSingle();
      if (!booking) {
        await logServerError(FN, `dispute ${d.id} has no booking`, { dispute_id: d.id }, { fatal: true });
        failed.push(d.id);
        continue;
      }

      const result = await settleEscrow(stripe, supabase, {
        bookingId: d.booking_id,
        earnerId: booking.earner_id,
        // settleEscrow takes a fraction and floors nothing; the 50% floor was applied
        // when the proposal was written and adjudication is bounded in the console.
        capturePct: Math.min(1, Math.max(0, pct / 100)),
      });
      if (!result.ok) {
        // HOLD_EXPIRED here is the outcome this whole control exists to prevent, and it
        // is fatal by any reading: the work was done, the poster was never charged, and
        // the earner cannot be paid by anything in this repo.
        await logServerError(FN,
          `settlement failed for dispute ${d.id} (${result.error}): booking ${d.booking_id}`,
          { dispute_id: d.id, booking_id: d.booking_id, error: result.error }, { fatal: true });
        failed.push(d.id);
        continue;
      }

      // Stamp what was ACTUALLY collected, from the ledger — settleEscrow reconciles
      // against Stripe's amount_received, so this can differ from what we asked for.
      const paidPct = Math.round(result.settledPct * 100);
      const { error: stampErr } = await supabase
        .from('disputes')
        .update({
          pct_paid: paidPct,
          settled_at: new Date().toISOString(),
          // A settled dispute stops blocking earner-claim-payment and stops holding a
          // third party's referral bonus in vest_bonuses. 'rejected' is the existing
          // enum value for "the reduction did not stand".
          status: paidPct >= 100 ? 'rejected' : 'resolved',
          resolved_at: new Date().toISOString(),
        })
        .eq('id', d.id)
        .is('pct_paid', null);
      if (stampErr) {
        await logServerError(FN,
          `captured but could not stamp dispute ${d.id}: ${stampErr.message}`,
          { dispute_id: d.id, booking_id: d.booking_id }, { fatal: true });
        failed.push(d.id);
        continue;
      }

      // The booking can only become `verified` now — guard_bookings_write refuses
      // completed→verified without a captured payment, which is exactly why the
      // proposal branch left it `completed`.
      if (booking.status === 'completed') {
        await supabase.from('bookings').update({ status: 'verified' }).eq('id', d.booking_id);
      }

      // Publish the poster's review, held until now for the same reason the money was:
      // a 1★ posted on a public profile before the earner has spoken is the same fait
      // accompli in reputation. Best-effort — the money has moved and a review write
      // must never be the thing that fails a settled capture.
      await publishHeldReview(supabase, d.booking_id);

      // Both parties are told the outcome, by the server. Durable inbox rows; the
      // clients render them from the same table the realtime badge reads.
      await notifyOutcome(supabase, d.id, d.booking_id, paidPct);

      settled.push(d.id);
     } catch (e) {
       // Fatal for THIS dispute, and the batch continues. Carries the ids the outer
       // catch could not, so /errors names the row that needs a human.
       await logServerError(FN,
         `settlement threw for dispute ${d.id} on booking ${d.booking_id}: `
         + `${e instanceof Error ? e.message : String(e)}`,
         { dispute_id: d.id, booking_id: d.booking_id }, { fatal: true });
       failed.push(d.id);
       continue;
     }
    }

    // `failed` is reported, never swallowed: ctl_dispute_settlement_overdue is the
    // control that must see a row this function could not pay.
    return json({ ok: true, settled: settled.length, skipped: skipped.length, failed: failed.length });
  } catch (err) {
    await logServerError(FN, `unhandled: ${err instanceof Error ? err.message : String(err)}`, {}, { fatal: true });
    return json({ error: 'server_error' }, 500);
  }
});

/** Insert the public review the poster wrote at verification time, once. */
async function publishHeldReview(
  supabase: SupabaseClient,
  bookingId: string,
): Promise<void> {
  try {
    const { data: b } = await supabase
      .from('bookings')
      .select('id, job_id, earner_id, earner_rating, review_text, job:jobs!bookings_job_id_fkey(poster_id)')
      .eq('id', bookingId)
      .maybeSingle();
    if (!b || !b.earner_rating) return;
    const posterId = Array.isArray(b.job) ? b.job[0]?.poster_id : (b.job as { poster_id?: string } | null)?.poster_id;
    if (!posterId) return;

    const { data: existing } = await supabase
      .from('reviews').select('id')
      .eq('job_id', b.job_id).eq('reviewer_id', posterId).eq('role', 'earner').maybeSingle();
    if (existing) return;

    const { data: poster } = await supabase.from('profiles').select('name').eq('id', posterId).maybeSingle();
    await supabase.from('reviews').insert({
      job_id: b.job_id,
      reviewer_id: posterId,
      reviewed_user_id: b.earner_id,
      author: poster?.name ?? 'A poster',
      role: 'earner',
      rating: b.earner_rating,
      text: b.review_text ?? null,
      date: new Date().toISOString(),
    });
    // `target`, not `p_user`. The live signature is recompute_user_rating(target uuid)
    // and both clients call it that way (JobsContext.js:684, web/lib/jobs.tsx:765); this
    // call site invented a parameter name that does not exist, so PostgREST answered
    // "function ... does not exist" every time. supabase.rpc RESOLVES with {error}, it
    // does not throw, and the result was discarded — so the surrounding try/catch never
    // saw it and nothing was logged. The review row landed on the earner's profile while
    // profiles.rating and review_count stayed where they were: a settled dispute
    // published a rating that counted for nothing.
    const { error: rateErr } = await supabase.rpc('recompute_user_rating', { target: b.earner_id });
    if (rateErr) {
      await logServerError(FN,
        `could not recompute the rating for earner ${b.earner_id} after publishing the held review: ${rateErr.message}`,
        { booking_id: bookingId });
    }
  } catch (e) {
    await logServerError(FN, `could not publish the held review for ${bookingId}: ${String((e as Error)?.message ?? e)}`,
      { booking_id: bookingId });
  }
}

/** Tell both parties what happened. Best-effort; the money has already moved. */
async function notifyOutcome(
  supabase: SupabaseClient,
  disputeId: string,
  bookingId: string,
  paidPct: number,
): Promise<void> {
  try {
    const { data: b } = await supabase
      .from('bookings')
      .select('earner_id, job_id, job:jobs!bookings_job_id_fkey(poster_id, title)')
      .eq('id', bookingId)
      .maybeSingle();
    if (!b) return;
    const job = Array.isArray(b.job) ? b.job[0] : b.job as { poster_id?: string; title?: string } | null;
    const title = job?.title ?? 'your gig';
    const rows: Record<string, unknown>[] = [{
      user_id: b.earner_id,
      type: 'payment',
      title: paidPct >= 100 ? 'Paid in full' : `Paid ${paidPct}%`,
      body: paidPct >= 100
        ? `The reported problem on ${title} did not stand, and you have been paid in full.`
        : `${title} settled at ${paidPct}%. Open Transactions for the receipt.`,
      job_id: b.job_id,
      data: { dispute_id: disputeId, booking_id: bookingId, tab: 'EarnTab' },
    }];
    if (job?.poster_id) {
      rows.push({
        user_id: job.poster_id,
        type: 'payment',
        title: 'Your report was settled',
        body: `${title} settled at ${paidPct}%.`,
        job_id: b.job_id,
        data: { dispute_id: disputeId, booking_id: bookingId, tab: 'GigsTab' },
      });
    }
    await supabase.from('notifications').insert(rows);
  } catch (e) {
    await logServerError(FN, `could not notify the outcome of ${disputeId}: ${String((e as Error)?.message ?? e)}`,
      { dispute_id: disputeId });
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
